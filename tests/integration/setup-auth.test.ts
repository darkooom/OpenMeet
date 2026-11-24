import { describe, expect, it } from "vitest";
import { ADMIN, SETUP_TOKEN, api, ensureSetup, env, login, registerUser } from "./helpers";
import { runMigrations } from "../../src/database/migrate";

const setupBody = (token: string, slug = "acme") => ({
  token,
  admin: ADMIN,
  instance: { productName: "OpenMeet Test", defaultLocale: "en", defaultTimezone: "Europe/Berlin", publicBaseUrl: null, registration: "open" },
  organization: { name: "Acme", slug },
  eventType: { title: "Intro call", slug: "intro", duration: 30 },
});

describe("first-run setup wizard", () => {
  it("reports a fresh instance and refuses wrong setup tokens", async () => {
    const status = await api("GET", "/api/setup/status");
    expect(status.status).toBe(200);
    if (status.json.setupCompleted) return; // storage shared with another file
    expect(status.json.setupTokenConfigured).toBe(true);
    // the token is never part of any response
    expect(JSON.stringify(status.json)).not.toContain(SETUP_TOKEN);
    const wrong = await api("POST", "/api/setup/verify", { body: { token: "nope-nope-nope-nope-nope-nope-nope" } });
    expect(wrong.status).toBe(403);
    const wrongComplete = await api("POST", "/api/setup/complete", { body: setupBody("x".repeat(40)) });
    expect(wrongComplete.status).toBe(403);
    expect((await api("GET", "/api/setup/status")).json.setupCompleted).toBe(false);
  });

  it("completes exactly once, even with concurrent requests", async () => {
    const before = await api("GET", "/api/setup/status");
    if (!before.json.setupCompleted) {
      const results = await Promise.all([api("POST", "/api/setup/complete", { body: setupBody(SETUP_TOKEN) }), api("POST", "/api/setup/complete", { body: setupBody(SETUP_TOKEN, "acme2") })]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 410]);
      const admins = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE is_super_admin = 1").first<{ n: number }>();
      expect(admins?.n).toBe(1);
    }
    const again = await api("POST", "/api/setup/complete", { body: setupBody(SETUP_TOKEN) });
    expect(again.status).toBe(410);
    const verify = await api("POST", "/api/setup/verify", { body: { token: SETUP_TOKEN } });
    expect(verify.status).toBe(410);
  });

  it("migrations are idempotent", async () => {
    await ensureSetup();
    expect(await runMigrations(env.DB)).toEqual([]);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM d1_migrations").first<{ n: number }>();
    expect(row?.n).toBeGreaterThanOrEqual(1);
  });
});

describe("authentication", () => {
  it("logs in, exposes /me and logs out (session revoked server side)", async () => {
    const cookie = await ensureSetup();
    const me = await api("GET", "/api/auth/me", { cookie });
    expect(me.json.user.email).toBe(ADMIN.email);
    expect(me.json.user.isSuperAdmin).toBe(true);
    const out = await api("POST", "/api/auth/logout", { cookie });
    expect(out.status).toBe(200);
    const after = await api("GET", "/api/auth/me", { cookie });
    expect(after.json.user).toBeNull();
  });

  it("rejects wrong passwords without revealing whether the account exists", async () => {
    await ensureSetup();
    const a = await api("POST", "/api/auth/login", { body: { email: ADMIN.email, password: "wrong-password-1" } });
    const b = await api("POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "wrong-password-1" } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json.error.message).toBe(b.json.error.message);
  });

  it("stores only password hashes and hashed session ids", async () => {
    const u = await registerUser("hash");
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email = ?").bind(u.email).first<{ password_hash: string }>();
    expect(row?.password_hash.startsWith("pbkdf2-sha256$")).toBe(true);
    const token = u.cookie.split("=")[1]!;
    const raw = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").bind(token).first<{ n: number }>();
    expect(raw?.n).toBe(0);
  });

  it("enforces CSRF protection for cookie-authenticated mutations", async () => {
    const cookie = await ensureSetup();
    const noHeader = await api("POST", "/api/event-types", { cookie, headers: { "x-openmeet-csrf": "0" }, body: { title: "x", slug: "x", duration: 30 } });
    expect(noHeader.status).toBe(403);
    const crossOrigin = await api("POST", "/api/event-types", { cookie, headers: { origin: "https://evil.example" }, body: { title: "x", slug: "x", duration: 30 } });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await api("POST", "/api/event-types", { cookie, headers: { "sec-fetch-site": "cross-site" }, body: { title: "x", slug: "x", duration: 30 } });
    expect(crossSite.status).toBe(403);
  });

  it("respects the registration policy", async () => {
    const admin = await ensureSetup();
    const cfg = { productName: "OpenMeet Test", defaultLocale: "en", defaultTimezone: "Europe/Berlin", publicBaseUrl: null, requireEmailVerification: true, retentionDays: null };
    expect((await api("PUT", "/api/admin/config", { cookie: admin, body: { ...cfg, registration: "invite_only" } })).status).toBe(200);
    const blocked = await api("POST", "/api/auth/register", { body: { name: "X", email: "blocked@example.com", password: "password-1234" } });
    expect(blocked.status).toBe(403);
    expect((await api("PUT", "/api/admin/config", { cookie: admin, body: { ...cfg, registration: "open" } })).status).toBe(200);
    const ok = await api("POST", "/api/auth/register", { body: { name: "X", email: "allowed@example.com", password: "password-1234" } });
    expect(ok.status).toBe(201);
    // weak passwords are refused
    const weak = await api("POST", "/api/auth/register", { body: { name: "X", email: "weak@example.com", password: "short" } });
    expect(weak.status).toBe(422);
  });

  it("supports password reset with single-use tokens and revokes sessions", async () => {
    const u = await registerUser("reset");
    expect((await api("POST", "/api/auth/forgot-password", { body: { email: u.email } })).status).toBe(200);
    expect((await api("POST", "/api/auth/forgot-password", { body: { email: "unknown@example.com" } })).status).toBe(200);
    // Issue a token directly (the e-mail itself is not readable in tests).
    const { issueToken } = await import("../../src/server/services/auth");
    const { drizzle } = await import("drizzle-orm/d1");
    const schema = await import("../../src/database/schema");
    const token = await issueToken(drizzle(env.DB, { schema }), "reset_password", u.id, 3600_000);
    const res = await api("POST", "/api/auth/reset-password", { body: { token, password: "new-password-99" } });
    expect(res.status).toBe(200);
    const reuse = await api("POST", "/api/auth/reset-password", { body: { token, password: "new-password-98" } });
    expect(reuse.status).toBe(410);
    expect((await api("GET", "/api/auth/me", { cookie: u.cookie })).json.user).toBeNull();
    await login(u.email, "new-password-99");
  });

  it("restricts administration to instance admins", async () => {
    const u = await registerUser("nonadmin");
    expect((await api("GET", "/api/admin/overview", { cookie: u.cookie })).status).toBe(403);
    const admin = await ensureSetup();
    const ov = await api("GET", "/api/admin/overview", { cookie: admin });
    expect(ov.status).toBe(200);
    expect(ov.json.database.counts.users).toBeGreaterThan(0);
    expect(JSON.stringify(ov.json)).not.toContain(SETUP_TOKEN);
  });
});
