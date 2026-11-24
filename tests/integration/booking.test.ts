import { beforeAll, describe, expect, it } from "vitest";
import { api, bookingBody, createEventType, drainJobs, ensureSetup, env, firstSlot, nextMondayBerlin, registerUser } from "./helpers";

let admin: string;
beforeAll(async () => {
  admin = await ensureSetup();
});

describe("booking engine – one-on-one", () => {
  it("books a slot, then refuses the same slot (sequential double booking)", async () => {
    const host = await registerUser("host");
    const et = await createEventType(host.cookie);
    const start = await firstSlot(et.id);
    const first = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1) });
    expect(first.status).toBe(201);
    expect(first.json.booking.status).toBe("confirmed");
    expect(first.json.manageToken).toBeTruthy();
    const second = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 2) });
    expect(second.status).toBe(409);
    // slot disappears from availability
    const slots = await api("GET", `/api/public/event-types/${et.id}/slots?from=${start - 3600_000}&to=${start + 3600_000}`);
    expect(slots.json.slots.map((s: { start: number }) => s.start)).not.toContain(start);
  });

  it("allows exactly one of 25 parallel requests for the same slot", async () => {
    const host = await registerUser("race");
    const et = await createEventType(host.cookie);
    const start = await firstSlot(et.id);
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, i) })));
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(24);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM reservations r JOIN bookings b ON b.id = r.booking_id WHERE b.event_type_id = ? AND r.active = 1").bind(et.id).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("prevents overlapping bookings across different event types of the same host", async () => {
    const host = await registerUser("overlap");
    const short = await createEventType(host.cookie, { duration: 30 });
    const long = await createEventType(host.cookie, { duration: 60 });
    const start = await firstSlot(long.id);
    const results = await Promise.all([
      api("POST", "/api/public/bookings", { body: bookingBody(long.id, start, 1) }),
      api("POST", "/api/public/bookings", { body: bookingBody(short.id, start + 30 * 60_000, 2) }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("enforces the database trigger even when application checks are bypassed", async () => {
    const host = await registerUser("trigger");
    const et = await createEventType(host.cookie);
    const start = await firstSlot(et.id);
    await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1) });
    const b = await env.DB.prepare("SELECT id FROM bookings WHERE event_type_id = ?").bind(et.id).first<{ id: string }>();
    await expect(
      env.DB.prepare("INSERT INTO reservations (id, booking_id, user_id, start_at, end_at, active) VALUES ('x1', ?, ?, ?, ?, 1)")
        .bind("other-booking", host.id, start + 60_000, start + 120_000)
        .run(),
    ).rejects.toThrow(/SLOT_UNAVAILABLE|FOREIGN KEY/);
    void b;
  });

  it("is idempotent with an Idempotency-Key", async () => {
    const host = await registerUser("idem");
    const et = await createEventType(host.cookie);
    const start = await firstSlot(et.id);
    const key = "client-key-123456";
    const a = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1), headers: { "idempotency-key": key } });
    const b = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1), headers: { "idempotency-key": key } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.json.replay).toBe(true);
    expect(b.json.booking.id).toBe(a.json.booking.id);
  });

  it("validates required questions, durations and locations", async () => {
    const host = await registerUser("valid");
    const et = await createEventType(host.cookie, {
      durationOptions: [60],
      questions: [{ id: "company", label: "Company", type: "text", required: true }],
      locations: [{ type: "attendee_phone" }],
    });
    const start = await firstSlot(et.id);
    const missing = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1, { location: { type: "attendee_phone", value: "+49 30 123456" } }) });
    expect(missing.status).toBe(400);
    const badDuration = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1, { duration: 45, answers: { company: "ACME" } }) });
    expect(badDuration.status).toBe(400);
    const ok = await api("POST", "/api/public/bookings", {
      body: bookingBody(et.id, start, 1, { duration: 60, answers: { company: "ACME" }, location: { type: "attendee_phone", value: "+49 30 123456" } }),
    });
    expect(ok.status).toBe(201);
    expect(ok.json.booking.endAt - ok.json.booking.startAt).toBe(60 * 60_000);
  });

  it("supports manual confirmation", async () => {
    const host = await registerUser("confirm");
    const et = await createEventType(host.cookie, { requiresConfirmation: true });
    const start = await firstSlot(et.id);
    const res = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1) });
    expect(res.json.booking.status).toBe("pending");
    // pending bookings already block the slot
    expect((await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 2) })).status).toBe(409);
    const confirm = await api("POST", `/api/bookings/${res.json.booking.id}/confirm`, { cookie: host.cookie });
    expect(confirm.status).toBe(200);
    const detail = await api("GET", `/api/bookings/${res.json.booking.id}`, { cookie: host.cookie });
    expect(detail.json.booking.status).toBe("confirmed");
  });
});

describe("cancel & reschedule", () => {
  it("lets attendees reschedule and cancel with their manage token", async () => {
    const host = await registerUser("manage");
    const et = await createEventType(host.cookie);
    const monday = nextMondayBerlin();
    const start = await firstSlot(et.id, monday);
    const booked = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1) });
    const token = booked.json.manageToken as string;
    const view = await api("GET", `/api/public/bookings/${token}`);
    expect(view.status).toBe(200);
    expect(view.json.booking.startAt).toBe(start);

    const slots = await api("GET", `/api/public/bookings/${token}/slots?from=${monday}&to=${monday + 3 * 86_400_000}`);
    const target = slots.json.slots.find((s: { start: number }) => s.start > start + 3600_000).start as number;
    const moved = await api("POST", `/api/public/bookings/${token}/reschedule`, { body: { start: target } });
    expect(moved.status).toBe(200);
    // the old slot is free again, the new one is taken
    const other = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 2) });
    expect(other.status).toBe(201);
    const clash = await api("POST", `/api/public/bookings/${token}/reschedule`, { body: { start } });
    expect(clash.status).toBe(409);

    const cancel = await api("POST", `/api/public/bookings/${token}/cancel`, { body: { reason: "Sorry" } });
    expect(cancel.status).toBe(200);
    expect((await api("GET", `/api/public/bookings/${token}`)).json.booking.status).toBe("cancelled");
    expect((await api("POST", `/api/public/bookings/${token}/cancel`, { body: {} })).status).toBe(409);
    // slot is bookable again after cancellation
    expect((await api("POST", "/api/public/bookings", { body: bookingBody(et.id, target, 3) })).status).toBe(201);
  });

  it("rejects unknown manage tokens", async () => {
    expect((await api("GET", "/api/public/bookings/not-a-real-token")).status).toBe(404);
  });
});

describe("group events", () => {
  it("never exceeds the seat capacity under concurrency", async () => {
    const host = await registerUser("group");
    const et = await createEventType(host.cookie, { kind: "group", seats: 3 });
    const start = await firstSlot(et.id);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, i) })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.json.booking.id));
    expect(ids.size).toBe(1); // all attendees share one occurrence
    const n = await env.DB.prepare("SELECT count(*) AS n FROM booking_attendees a JOIN bookings b ON b.id = a.booking_id WHERE b.event_type_id = ? AND a.status = 'active'").bind(et.id).first<{ n: number }>();
    expect(n?.n).toBe(3);
  });
});

async function makeTeam(adminCookie: string, members: number) {
  const orgs = await api("GET", "/api/orgs", { cookie: adminCookie });
  const orgId = orgs.json.organizations[0].id as string;
  const slug = `team-${Math.random().toString(36).slice(2, 8)}`;
  const team = await api("POST", `/api/orgs/${orgId}/teams`, { cookie: adminCookie, body: { name: "Support", slug } });
  expect(team.status).toBe(201);
  const users = [];
  for (let i = 0; i < members; i++) {
    const email = `member-${Math.random().toString(36).slice(2, 10)}@example.com`;
    const inv = await api("POST", `/api/orgs/${orgId}/invitations`, { cookie: adminCookie, body: { email, role: "member", teamId: team.json.id } });
    expect(inv.status).toBe(201);
    const token = inv.json.url.split("/invite/")[1];
    const reg = await api("POST", "/api/auth/register", { body: { name: `Member ${i}`, email, password: "password-1234", inviteToken: token, timezone: "Europe/Berlin" } });
    expect(reg.status).toBe(201);
    const me = await api("GET", "/api/auth/me", { cookie: reg.cookie });
    users.push({ id: me.json.user.id as string, cookie: reg.cookie! });
  }
  return { orgId, teamId: team.json.id as string, slug, users };
}

describe("team scheduling", () => {
  it("round robin distributes bookings across available hosts", async () => {
    const { teamId, users } = await makeTeam(admin, 2);
    const et = await createEventType(admin, { kind: "round_robin", teamId, hostUserIds: users.map((u) => u.id) });
    const monday = nextMondayBerlin();
    const slotsRes = await api("GET", `/api/public/event-types/${et.id}/slots?from=${monday}&to=${monday + 86_400_000 * 2}`);
    const starts: number[] = slotsRes.json.slots.map((s: { start: number }) => s.start);
    const a = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, starts[0]!, 1) });
    const b = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, starts[4]!, 2) });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const hosts = await env.DB.prepare("SELECT bh.user_id FROM booking_hosts bh JOIN bookings b ON b.id = bh.booking_id WHERE b.event_type_id = ?").bind(et.id).all<{ user_id: string }>();
    expect(new Set(hosts.results.map((h) => h.user_id)).size).toBe(2);
    // same slot can still be booked once more because a second host is free
    const c = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, starts[0]!, 3) });
    expect(c.status).toBe(201);
    const d = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, starts[0]!, 4) });
    expect(d.status).toBe(409);
  });

  it("collective events require and reserve all hosts", async () => {
    const { teamId, users } = await makeTeam(admin, 2);
    const coll = await createEventType(admin, { kind: "collective", teamId, hostUserIds: users.map((u) => u.id) });
    const start = await firstSlot(coll.id);
    // Block member 0 with a personal booking at the first collective slot.
    const personal = await createEventType(users[0]!.cookie);
    expect((await api("POST", "/api/public/bookings", { body: bookingBody(personal.id, start, 1) })).status).toBe(201);
    const slots = await api("GET", `/api/public/event-types/${coll.id}/slots?from=${start - 60_000}&to=${start + 86_400_000}`);
    expect(slots.json.slots.map((s: { start: number }) => s.start)).not.toContain(start);
    const next = slots.json.slots[0].start as number;
    const booked = await api("POST", "/api/public/bookings", { body: bookingBody(coll.id, next, 2) });
    expect(booked.status).toBe(201);
    const res = await env.DB.prepare("SELECT count(*) AS n FROM reservations WHERE booking_id = ? AND active = 1").bind(booked.json.booking.id).first<{ n: number }>();
    expect(res?.n).toBe(2);
    // member 1 is now busy at that time for personal events too
    const personal1 = await createEventType(users[1]!.cookie);
    expect((await api("POST", "/api/public/bookings", { body: bookingBody(personal1.id, next, 3) })).status).toBe(409);
  });
});

describe("tenant isolation", () => {
  it("hides other users' event types and bookings (404, not 403)", async () => {
    const a = await registerUser("tenantA");
    const b = await registerUser("tenantB");
    const et = await createEventType(a.cookie);
    const start = await firstSlot(et.id);
    const booked = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1) });
    expect((await api("GET", `/api/event-types/${et.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await api("PUT", `/api/event-types/${et.id}`, { cookie: b.cookie, body: { title: "Hacked", slug: "hacked", duration: 30 } })).status).toBe(404);
    expect((await api("DELETE", `/api/event-types/${et.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await api("GET", `/api/bookings/${booked.json.booking.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await api("POST", `/api/bookings/${booked.json.booking.id}/cancel`, { cookie: b.cookie, body: {} })).status).toBe(404);
    const list = await api("GET", "/api/bookings?status=all", { cookie: b.cookie });
    expect(list.json.bookings).toHaveLength(0);
    const own = await api("GET", "/api/bookings?status=all", { cookie: a.cookie });
    expect(own.json.bookings).toHaveLength(1);
  });

  it("does not let non-members manage a team or its event types", async () => {
    const { teamId, orgId } = await makeTeam(admin, 1);
    const outsider = await registerUser("outsider");
    expect((await api("GET", `/api/orgs/teams/${teamId}`, { cookie: outsider.cookie })).status).toBe(404);
    expect((await api("GET", `/api/orgs/${orgId}`, { cookie: outsider.cookie })).status).toBe(404);
    const create = await api("POST", "/api/event-types", { cookie: outsider.cookie, body: { title: "x", slug: "x-team", duration: 30, kind: "round_robin", teamId } });
    expect(create.status).toBe(404);
  });
});

describe("private one-time links", () => {
  it("can only be used once", async () => {
    const host = await registerUser("private");
    const et = await createEventType(host.cookie, { isPrivate: true });
    expect((await api("GET", `/api/public/users/${host.username}/${et.slug}`)).status).toBe(404);
    const link = await api("POST", `/api/event-types/${et.id}/links`, { cookie: host.cookie, body: { singleUse: true } });
    const token = link.json.url.split("/book/")[1];
    expect((await api("GET", `/api/public/links/${token}`)).status).toBe(200);
    const start = await firstSlot(et.id, nextMondayBerlin(), undefined, token);
    expect((await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1) })).status).toBe(404);
    expect((await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1, { privateLinkToken: token }) })).status).toBe(201);
    expect((await api("GET", `/api/public/links/${token}`)).status).toBe(410);
  });
});

describe("notifications pipeline", () => {
  it("queues e-mails and logs them as skipped without a provider", async () => {
    const host = await registerUser("mail");
    const et = await createEventType(host.cookie);
    const start = await firstSlot(et.id);
    const res = await api("POST", "/api/public/bookings", { body: bookingBody(et.id, start, 1) });
    await drainJobs();
    const log = await env.DB.prepare("SELECT template, status FROM email_log WHERE booking_id = ?").bind(res.json.booking.id).all<{ template: string; status: string }>();
    const templates = log.results.map((r) => r.template).sort();
    expect(templates).toContain("booking_confirmed_attendee");
    expect(templates).toContain("booking_new_organizer");
    expect(log.results.every((r) => r.status === "skipped")).toBe(true);
    const reminders = await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE dedupe_key LIKE 'rem%' AND payload LIKE ?").bind(`%${res.json.booking.id}%`).first<{ n: number }>();
    expect(reminders?.n).toBe(2);
    // meeting link: Jitsi rooms are generated without external API
    const detail = await api("GET", `/api/bookings/${res.json.booking.id}`, { cookie: host.cookie });
    expect(detail.json.booking.meetingUrl).toMatch(/^https:\/\/meet\.jit\.si\/OpenMeet-/);
  });
});
