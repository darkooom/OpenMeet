import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schema from "../../src/database/schema";
import { encryptString } from "../../src/server/security/crypto";
import { verifySignature } from "../../src/server/services/webhooks";
import { api, bookingBody, createEventType, drainJobs, ensureSetup, env, firstSlot, nextMondayBerlin, registerUser } from "./helpers";

let admin: string;
beforeAll(async () => {
  admin = await ensureSetup();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("DELETE FROM app_credentials").run();
});

/** Replaces outbound fetch for the given hosts (test-only mock provider). */
function mockFetch(handler: (url: string, init: RequestInit) => Response | null | Promise<Response | null>) {
  const real = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const res = await handler(url, init ?? {});
    if (res) {
      calls.push({ url, init: init ?? {} });
      return res;
    }
    return real(input as RequestInfo, init);
  });
  return calls;
}

describe("database schema", () => {
  it("drizzle schema matches the SQL migrations", async () => {
    const tables = Object.values(schema).filter((t) => t && typeof t === "object" && Symbol.for("drizzle:Name") in (t as object));
    expect(tables.length).toBeGreaterThan(30);
    for (const table of tables) {
      const name = (table as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")]!;
      const { results } = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>();
      const dbCols = results.map((r) => r.name).sort();
      const drizzleCols = Object.values(getTableColumns(table as never)).map((c) => (c as { name: string }).name).sort();
      expect({ table: name, cols: drizzleCols }).toEqual({ table: name, cols: dbCols });
    }
  });
});

describe("API keys & public API", () => {
  it("authenticates with scoped, revocable keys", async () => {
    const u = await registerUser("apikey");
    const et = await createEventType(u.cookie);
    const created = await api("POST", "/api/me/api-keys", { cookie: u.cookie, body: { name: "CRM", scopes: ["event_types:read", "bookings:read"] } });
    expect(created.status).toBe(201);
    const key = created.json.key as string;
    expect(key.startsWith("om_live_")).toBe(true);
    const stored = await env.DB.prepare("SELECT key_hash FROM api_keys WHERE id = ?").bind(created.json.id).first<{ key_hash: string }>();
    expect(stored?.key_hash).not.toContain(key);

    const list = await api("GET", "/api/v1/event-types", { headers: { authorization: `Bearer ${key}` } });
    expect(list.status).toBe(200);
    expect(list.json.data.map((e: { id: string }) => e.id)).toContain(et.id);
    // missing scope
    const write = await api("POST", "/api/v1/bookings", { headers: { authorization: `Bearer ${key}` }, body: bookingBody(et.id, Date.now()) });
    expect(write.status).toBe(403);
    // API keys cannot use the dashboard API
    expect((await api("GET", "/api/event-types", { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
    // revoke
    await api("DELETE", `/api/me/api-keys/${created.json.id}`, { cookie: u.cookie });
    expect((await api("GET", "/api/v1/event-types", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    expect((await api("GET", "/api/v1/event-types", { headers: { authorization: "Bearer om_live_definitely_not_a_valid_key" } })).status).toBe(401);
  });

  it("serves an OpenAPI document", async () => {
    const res = await api("GET", "/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.json.openapi).toBe("3.1.0");
    expect(Object.keys(res.json.paths)).toContain("/bookings");
  });

  it("lets an AI agent with a service token book, list and cancel – with audit log and tenant isolation", async () => {
    const owner = await registerUser("agentowner");
    const other = await registerUser("agentother");
    const et = await createEventType(owner.cookie);
    const foreign = await createEventType(other.cookie);
    const svc = await api("POST", "/api/me/api-keys", { cookie: owner.cookie, body: { name: "NOVA", kind: "service", scopes: ["agent"] } });
    const auth = { authorization: `Bearer ${svc.json.key}` };
    expect(svc.json.key.startsWith("om_svc_")).toBe(true);

    const from = nextMondayBerlin();
    const avail = await api("GET", `/api/v1/agent/availability?eventTypeId=${et.id}&from=${from}&to=${from + 3 * 86_400_000}`, { headers: auth });
    expect(avail.status).toBe(200);
    const start = avail.json.data.slots[0].startMs as number;
    const booked = await api("POST", "/api/v1/agent/bookings", { headers: { ...auth, "idempotency-key": "agent-req-0001" }, body: bookingBody(et.id, start, 7) });
    expect(booked.status).toBe(201);
    const replay = await api("POST", "/api/v1/agent/bookings", { headers: { ...auth, "idempotency-key": "agent-req-0001" }, body: bookingBody(et.id, start, 7) });
    expect(replay.status).toBe(200);
    expect(replay.json.data.id).toBe(booked.json.data.id);

    // cannot touch another tenant's event type
    expect((await api("GET", `/api/v1/agent/availability?eventTypeId=${foreign.id}`, { headers: auth })).status).toBe(404);
    expect((await api("POST", "/api/v1/agent/bookings", { headers: auth, body: bookingBody(foreign.id, start, 8) })).status).toBe(404);

    const link = await api("POST", "/api/v1/agent/booking-links", { headers: auth, body: { eventTypeId: et.id } });
    expect(link.status).toBe(201);
    expect(link.json.data.url).toContain("/book/");

    const day = new Date(start).toISOString().slice(0, 10);
    const agenda = await api("GET", `/api/v1/agent/agenda?date=${day}`, { headers: auth });
    expect(agenda.status).toBe(200);
    expect(agenda.json.data.count).toBeGreaterThanOrEqual(1);

    const cancel = await api("POST", `/api/v1/agent/bookings/${booked.json.data.id}/cancel`, { headers: auth, body: { reason: "Agent test" } });
    expect(cancel.status).toBe(200);
    const audits = await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE actor_type = 'api_key' AND actor_id = ? AND action LIKE 'agent.%'").bind(svc.json.id).first<{ n: number }>();
    expect(audits?.n).toBeGreaterThanOrEqual(5);
  });
});

describe("webhooks & workflows", () => {
  it("delivers signed webhooks and runs workflow steps", async () => {
    const u = await registerUser("hooks");
    const et = await createEventType(u.cookie);
    const hook = await api("POST", "/api/automation/webhooks", { cookie: u.cookie, body: { url: "https://hooks.example.com/openmeet", events: ["booking.created", "booking.cancelled"] } });
    expect(hook.status).toBe(201);
    const secret = hook.json.secret as string;
    // SSRF: internal targets are refused at configuration time
    expect((await api("POST", "/api/automation/webhooks", { cookie: u.cookie, body: { url: "https://169.254.169.254/x", events: ["booking.created"] } })).status).toBe(400);
    const wf = await api("POST", "/api/automation/workflows", {
      cookie: u.cookie,
      body: { name: "Slack", trigger: "booking.created", steps: [{ type: "slack", webhookUrl: "https://hooks.slack.example/services/T/B/X", text: "New: {{attendee.name}} for {{event.title}}" }] },
    });
    expect(wf.status).toBe(201);

    const calls = mockFetch((url) => (url.startsWith("https://hooks.example.com") || url.startsWith("https://hooks.slack.example") ? new Response("ok", { status: 200 }) : null));
    const start = await firstSlot(et.id);
    const res = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 42) });
    expect(res.status).toBe(201);
    await drainJobs();

    const hookCall = calls.find((c) => c.url.startsWith("https://hooks.example.com"));
    expect(hookCall).toBeTruthy();
    const headers = new Headers(hookCall!.init.headers);
    const body = String(hookCall!.init.body);
    expect(headers.get("x-openmeet-event")).toBe("booking.created");
    expect(await verifySignature(secret, body, headers.get("x-openmeet-signature")!)).toBe(true);
    expect(JSON.parse(body).data.attendees[0].name).toBe("Guest 42");

    const slack = calls.find((c) => c.url.startsWith("https://hooks.slack.example"));
    expect(JSON.parse(String(slack!.init.body)).text).toBe(`New: Guest 42 for ${et.title}`);
    const run = await env.DB.prepare("SELECT status FROM workflow_runs WHERE workflow_id = ?").bind(wf.json.id).first<{ status: string }>();
    expect(run?.status).toBe("succeeded");
    const delivery = await env.DB.prepare("SELECT success FROM webhook_deliveries WHERE webhook_id = ?").bind(hook.json.id).first<{ success: number }>();
    expect(delivery?.success).toBe(1);
  });

  it("retries failed webhook deliveries with backoff", async () => {
    const u = await registerUser("retry");
    const et = await createEventType(u.cookie);
    await api("POST", "/api/automation/webhooks", { cookie: u.cookie, body: { url: "https://flaky.example.com/hook", events: ["booking.created"] } });
    mockFetch((url) => (url.startsWith("https://flaky.example.com") ? new Response("down", { status: 503 }) : null));
    const start = await firstSlot(et.id);
    await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1) });
    await drainJobs();
    const job = await env.DB.prepare("SELECT status, attempts, run_at, last_error FROM jobs WHERE type = 'webhook.deliver' ORDER BY created_at DESC LIMIT 1").first<{ status: string; attempts: number; run_at: number; last_error: string }>();
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(1);
    expect(job!.run_at).toBeGreaterThan(Date.now() + 20_000);
    expect(job?.last_error).toContain("503");
  });
});

describe("e-mail provider", () => {
  it("sends confirmations through Resend with an ICS attachment and logs delivery", async () => {
    // Registered before the provider exists: with a provider, new accounts must confirm their e-mail first.
    const u = await registerUser("mailer");
    const et = await createEventType(u.cookie);
    const cfgRes = await api("PUT", "/api/admin/credentials/email", { cookie: admin, body: { provider: "resend", apiKey: "re_test_1234567890", fromEmail: "noreply@openmeet.test", fromName: "OpenMeet" } });
    expect(cfgRes.status).toBe(200);
    const stored = await env.DB.prepare("SELECT data_enc FROM app_credentials WHERE provider = 'email'").first<{ data_enc: string }>();
    expect(stored?.data_enc).not.toContain("re_test_1234567890");
    const calls = mockFetch((url) => (url === "https://api.resend.com/emails" ? Response.json({ id: `msg_${Math.random()}` }) : null));
    const start = await firstSlot(et.id);
    const res = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 5) });
    expect(res.json.emailEnabled).toBe(true);
    await drainJobs();
    const attendeeMail = calls.map((c) => JSON.parse(String(c.init.body))).find((b) => b.to[0] === "guest5@example.org");
    expect(attendeeMail.subject).toContain(et.title);
    expect(attendeeMail.attachments[0].filename).toBe("invite.ics");
    expect(attendeeMail.html).toContain(`/cancel/${res.json.manageToken}`);
    const log = await env.DB.prepare("SELECT status FROM email_log WHERE booking_id = ? AND to_email = ?").bind(res.json.booking.id, "guest5@example.org").first<{ status: string }>();
    expect(log?.status).toBe("sent");
    await api("DELETE", "/api/admin/credentials/email", { cookie: admin });
  });
});

describe("calendar integration (Google adapter)", () => {
  it("blocks externally busy times, refreshes expired tokens and creates events with Meet links", async () => {
    await api("PUT", "/api/admin/credentials/google", { cookie: admin, body: { clientId: "test-client-id.apps.googleusercontent.com", clientSecret: "test-secret-123" } });
    const u = await registerUser("gcal");
    const et = await createEventType(u.cookie, { locations: [{ type: "google_meet" }] });
    const start = await firstSlot(et.id);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO calendar_connections (id, user_id, provider, account_email, access_token_enc, refresh_token_enc, expires_at, status, created_at, updated_at) VALUES ('gc1', ?, 'google', 'g@example.com', ?, ?, ?, 'active', ?, ?)",
    )
      .bind(u.id, await encryptString(env.ENCRYPTION_KEY, "expired-access", "calendar"), await encryptString(env.ENCRYPTION_KEY, "refresh-123", "calendar"), now - 1000, now, now)
      .run();
    await env.DB.prepare("INSERT INTO calendars (id, connection_id, external_id, name, check_conflicts, is_target, is_primary) VALUES ('cal1', 'gc1', 'primary', 'Work', 1, 1, 1)").run();

    const calls = mockFetch(async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fresh-access", expires_in: 3600 });
      if (url.endsWith("/freeBusy")) {
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer fresh-access");
        return Response.json({ calendars: { primary: { busy: [{ start: new Date(start).toISOString(), end: new Date(start + 30 * 60_000).toISOString() }] } } });
      }
      if (url.includes("/calendars/primary/events")) return Response.json({ id: "evt_1", hangoutLink: "https://meet.google.com/abc-defg-hij" });
      return null;
    });

    const slots = await api("GET", `/api/public/event-types/${et.id}/slots?from=${start - 60_000}&to=${start + 86_400_000}`);
    expect(slots.json.slots.map((s: { start: number }) => s.start)).not.toContain(start);
    const conn = await env.DB.prepare("SELECT expires_at FROM calendar_connections WHERE id = 'gc1'").first<{ expires_at: number }>();
    expect(conn!.expires_at).toBeGreaterThan(now + 3000_000);
    expect(calls.some((c) => c.url === "https://oauth2.googleapis.com/token")).toBe(true);

    const next = slots.json.slots[0].start as number;
    const booked = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, next, 9) });
    expect(booked.status).toBe(201);
    await drainJobs();
    const ext = await env.DB.prepare("SELECT external_event_id FROM booking_external_events WHERE booking_id = ?").bind(booked.json.booking.id).first<{ external_event_id: string }>();
    expect(ext?.external_event_id).toBe("evt_1");
    const b = await env.DB.prepare("SELECT meeting_url FROM bookings WHERE id = ?").bind(booked.json.booking.id).first<{ meeting_url: string }>();
    expect(b?.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    const create = calls.find((c) => c.url.includes("/events?conferenceDataVersion=1"));
    expect(JSON.parse(String(create!.init.body)).conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    await api("DELETE", "/api/admin/credentials/google", { cookie: admin });
  });

  it("marks a connection revoked when the refresh token is invalid (fail-open for bookings)", async () => {
    await api("PUT", "/api/admin/credentials/google", { cookie: admin, body: { clientId: "test-client-id.apps.googleusercontent.com", clientSecret: "test-secret-123" } });
    const u = await registerUser("gcalbad");
    const et = await createEventType(u.cookie);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO calendar_connections (id, user_id, provider, access_token_enc, refresh_token_enc, expires_at, status, created_at, updated_at) VALUES ('gc2', ?, 'google', ?, ?, ?, 'active', ?, ?)",
    )
      .bind(u.id, await encryptString(env.ENCRYPTION_KEY, "x", "calendar"), await encryptString(env.ENCRYPTION_KEY, "bad", "calendar"), now - 1000, now, now)
      .run();
    await env.DB.prepare("INSERT INTO calendars (id, connection_id, external_id, name, check_conflicts) VALUES ('cal2', 'gc2', 'primary', 'Work', 1)").run();
    mockFetch((url) => (url === "https://oauth2.googleapis.com/token" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : null));
    const start = await firstSlot(et.id);
    expect(start).toBeGreaterThan(0);
    const conn = await env.DB.prepare("SELECT status FROM calendar_connections WHERE id = 'gc2'").first<{ status: string }>();
    expect(conn?.status).toBe("revoked");
    await api("DELETE", "/api/admin/credentials/google", { cookie: admin });
  });
});

describe("routing forms", () => {
  it("routes visitors to the matching event type", async () => {
    const u = await registerUser("router");
    const support = await createEventType(u.cookie, { title: "Support" });
    const sales = await createEventType(u.cookie, { title: "Sales" });
    const form = await api("POST", "/api/automation/routing-forms", {
      cookie: u.cookie,
      body: {
        name: "How can we help?",
        fields: [{ id: "topic", label: "Topic", type: "select", required: true, options: ["Technical support", "Sales"] }],
        rules: [{ id: "r1", conditions: [{ fieldId: "topic", op: "equals", value: "Sales" }], target: { type: "event_type", eventTypeId: sales.id } }],
        fallback: { type: "event_type", eventTypeId: support.id },
      },
    });
    expect(form.status).toBe(201);
    const a = await api("POST", `/api/public/forms/${form.json.id}/submit`, { body: { answers: { topic: "Sales" } } });
    expect(a.json.target.path).toBe(`/u/${u.username}/${sales.slug}`);
    const b = await api("POST", `/api/public/forms/${form.json.id}/submit`, { body: { answers: { topic: "Technical support" } } });
    expect(b.json.target.path).toBe(`/u/${u.username}/${support.slug}`);
    expect((await api("POST", `/api/public/forms/${form.json.id}/submit`, { body: { answers: {} } })).status).toBe(400);
    // targets must belong to the form owner
    const other = await registerUser("router2");
    const bad = await api("POST", "/api/automation/routing-forms", { cookie: other.cookie, body: { name: "x", fields: [{ id: "a", label: "A", type: "text", required: false }], rules: [], fallback: { type: "event_type", eventTypeId: sales.id } } });
    expect(bad.status).toBe(400);
  });
});
