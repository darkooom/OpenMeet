/** Instance administration (super admins only, enforced in index.ts). */
import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { auditLogs, emailLog, jobs, organizations, sessions, users, webhookDeliveries } from "../../database/schema";
import type { AppEnv } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { readBody } from "../lib/validate";
import { emailSchema, localeSchema, passwordSchema, timezoneSchema, usernameSchema } from "../../shared/schemas";
import { audit } from "../services/audit";
import { buildCreateUser, usernameAvailable } from "../services/auth";
import { credentialStatus, getConfig, setConfig, setCredentials, type CredentialProvider } from "../services/settings";
import { queueRawEmail } from "../services/mailer";
import { simpleEmail } from "../services/notifications";
import { MIGRATIONS } from "../../database/migrate";

export const adminRoutes = new Hono<AppEnv>();

const TABLES = ["users", "organizations", "teams", "event_types", "bookings", "booking_attendees", "calendar_connections", "workflows", "webhooks", "routing_forms", "api_keys", "jobs", "email_log", "audit_logs"];

adminRoutes.get("/overview", async (c) => {
  const db = c.get("db");
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await c.env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>();
    counts[t] = r?.n ?? 0;
  }
  const jobStats = await db.select({ status: jobs.status, n: sql<number>`count(*)` }).from(jobs).groupBy(jobs.status);
  const migrations = await c.env.DB.prepare("SELECT name, applied_at FROM d1_migrations ORDER BY id").all<{ name: string; applied_at: string }>();
  const size = await c.env.DB.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").first<{ bytes: number }>().catch(() => null);
  const started = Date.now();
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({
    version: c.env.APP_VERSION ?? "dev",
    config: await getConfig(db),
    credentials: await credentialStatus(db),
    secrets: { setupToken: !!c.env.SETUP_TOKEN, encryptionKey: !!c.env.ENCRYPTION_KEY },
    health: { database: "ok", dbLatencyMs: Date.now() - started },
    database: { counts, sizeBytes: size?.bytes ?? null, migrations: migrations.results, knownMigrations: MIGRATIONS.map((m) => m.name) },
    jobs: Object.fromEntries(jobStats.map((j) => [j.status, Number(j.n)])),
  });
});

adminRoutes.put("/config", async (c) => {
  const db = c.get("db");
  const input = await readBody(
    c,
    z.object({
      productName: z.string().trim().min(1).max(60),
      defaultLocale: localeSchema,
      defaultTimezone: timezoneSchema,
      publicBaseUrl: z.string().url().max(300).nullish(),
      registration: z.enum(["open", "invite_only", "closed"]),
      requireEmailVerification: z.boolean(),
      retentionDays: z.number().int().min(30).max(3650).nullish(),
    }),
  );
  await setConfig(db, { ...input, publicBaseUrl: input.publicBaseUrl ? input.publicBaseUrl.replace(/\/+$/, "") : null, retentionDays: input.retentionDays ?? null });
  await audit(db, c.get("actor"), "admin.config_updated", null, { registration: input.registration }, c.get("ip"));
  return c.json({ ok: true });
});

const credentialSchemas = {
  email: z.object({ provider: z.enum(["resend", "brevo", "postmark"]), apiKey: z.string().min(8).max(300), fromEmail: emailSchema, fromName: z.string().min(1).max(80) }),
  google: z.object({ clientId: z.string().min(5).max(300), clientSecret: z.string().min(5).max(300) }),
  microsoft: z.object({ clientId: z.string().min(5).max(300), clientSecret: z.string().min(5).max(300), tenant: z.string().min(1).max(100).default("common") }),
  zoom: z.object({ clientId: z.string().min(5).max(300), clientSecret: z.string().min(5).max(300) }),
} as const;

adminRoutes.put("/credentials/:provider", async (c) => {
  const provider = c.req.param("provider") as CredentialProvider;
  const schema = credentialSchemas[provider];
  if (!schema) throw badRequest("Unknown provider");
  const data = await readBody(c, schema);
  await setCredentials(c.get("db"), c.env, provider, data as never);
  await audit(c.get("db"), c.get("actor"), "admin.credentials_updated", null, { provider }, c.get("ip"));
  return c.json({ ok: true });
});

adminRoutes.delete("/credentials/:provider", async (c) => {
  const provider = c.req.param("provider") as CredentialProvider;
  if (!(provider in credentialSchemas)) throw badRequest("Unknown provider");
  await setCredentials(c.get("db"), c.env, provider, null);
  await audit(c.get("db"), c.get("actor"), "admin.credentials_removed", null, { provider }, c.get("ip"));
  return c.json({ ok: true });
});

adminRoutes.post("/credentials/email/test", async (c) => {
  const user = c.get("actor")!.user;
  const cfg = await getConfig(c.get("db"));
  await queueRawEmail(c.env, user.email, `${cfg.productName}: test e-mail`, simpleEmail(cfg.productName, "It works!", ["Your e-mail provider is configured correctly."]), "test", user.name);
  return c.json({ ok: true, message: "Test e-mail queued. Check the e-mail log in a few seconds." });
});

adminRoutes.get("/users", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 100);
  const rows = await c
    .get("db")
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      username: users.username,
      isSuperAdmin: users.isSuperAdmin,
      disabledAt: users.disabledAt,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(q ? or(like(users.email, `%${q}%`), like(users.name, `%${q}%`), like(users.username, `%${q}%`)) : undefined)
    .orderBy(desc(users.createdAt))
    .limit(200);
  return c.json({ users: rows });
});

adminRoutes.post("/users", async (c) => {
  const db = c.get("db");
  const cfg = await getConfig(db);
  const input = await readBody(c, z.object({ name: z.string().trim().min(1).max(120), email: emailSchema, username: usernameSchema, password: passwordSchema }));
  if (!(await usernameAvailable(db, input.username))) throw badRequest("Username taken");
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).get();
  if (existing) throw badRequest("E-mail already registered");
  const { userId, stmts } = await buildCreateUser(db, { ...input, timezone: cfg.defaultTimezone, locale: cfg.defaultLocale, emailVerified: true });
  await db.batch(stmts as never);
  await audit(db, c.get("actor"), "admin.user_created", { type: "user", id: userId }, undefined, c.get("ip"));
  return c.json({ id: userId }, 201);
});

adminRoutes.put("/users/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("actor")!.user;
  const input = await readBody(c, z.object({ isSuperAdmin: z.boolean().optional(), disabled: z.boolean().optional() }));
  const target = await db.select().from(users).where(eq(users.id, c.req.param("id"))).get();
  if (!target) throw notFound("User not found");
  if (target.id === me.id && (input.isSuperAdmin === false || input.disabled)) throw badRequest("You cannot demote or disable yourself");
  const now = Date.now();
  await db.batch([
    db
      .update(users)
      .set({
        ...(input.isSuperAdmin !== undefined ? { isSuperAdmin: input.isSuperAdmin } : {}),
        ...(input.disabled !== undefined ? { disabledAt: input.disabled ? now : null } : {}),
        updatedAt: now,
      })
      .where(eq(users.id, target.id)),
    ...(input.disabled ? [db.update(sessions).set({ revokedAt: now }).where(eq(sessions.userId, target.id))] : []),
  ] as never);
  await audit(db, c.get("actor"), "admin.user_updated", { type: "user", id: target.id }, input, c.get("ip"));
  return c.json({ ok: true });
});

adminRoutes.get("/organizations", async (c) => {
  const rows = await c
    .get("db")
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, createdAt: organizations.createdAt, members: sql<number>`(SELECT count(*) FROM memberships m WHERE m.org_id = ${organizations.id})` })
    .from(organizations)
    .orderBy(desc(organizations.createdAt));
  return c.json({ organizations: rows });
});

adminRoutes.get("/audit-logs", async (c) => {
  const rows = await c.get("db").select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(300);
  return c.json({ logs: rows });
});

adminRoutes.get("/email-log", async (c) => {
  const rows = await c.get("db").select().from(emailLog).orderBy(desc(emailLog.createdAt)).limit(300);
  return c.json({ emails: rows });
});

adminRoutes.get("/webhook-deliveries", async (c) => {
  const rows = await c.get("db").select().from(webhookDeliveries).orderBy(desc(webhookDeliveries.createdAt)).limit(300);
  return c.json({ deliveries: rows });
});

adminRoutes.get("/jobs", async (c) => {
  const status = c.req.query("status") ?? "dead";
  const rows = await c
    .get("db")
    .select({ id: jobs.id, type: jobs.type, status: jobs.status, attempts: jobs.attempts, lastError: jobs.lastError, runAt: jobs.runAt, updatedAt: jobs.updatedAt })
    .from(jobs)
    .where(eq(jobs.status, status as "dead"))
    .orderBy(desc(jobs.updatedAt))
    .limit(200);
  return c.json({ jobs: rows });
});

adminRoutes.post("/jobs/:id/retry", async (c) => {
  const row = await c
    .get("db")
    .update(jobs)
    .set({ status: "pending", attempts: 0, runAt: Date.now(), updatedAt: Date.now() })
    .where(and(eq(jobs.id, c.req.param("id")), eq(jobs.status, "dead")))
    .returning({ id: jobs.id })
    .get();
  if (!row) throw notFound("Job not found");
  return c.json({ ok: true });
});

/**
 * Logical JSON export of all tenant data (without secrets). For full,
 * restorable backups use D1 Time Travel or `wrangler d1 export` (see DEPLOYMENT.md).
 */
adminRoutes.get("/export", async (c) => {
  const out: Record<string, unknown[]> = {};
  const secretColumns = new Set(["password_hash", "access_token_enc", "refresh_token_enc", "credentials_enc", "secret_enc", "key_hash", "manage_token_hash", "manage_token_enc", "token_hash", "data_enc"]);
  for (const t of ["users", "organizations", "memberships", "teams", "team_members", "schedules", "availability_rules", "date_overrides", "event_types", "event_type_hosts", "bookings", "booking_hosts", "booking_attendees", "contacts", "workflows", "routing_forms", "routing_responses", "webhooks", "instance_settings"]) {
    const { results } = await c.env.DB.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>();
    out[t] = results.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !secretColumns.has(k))));
  }
  await audit(c.get("db"), c.get("actor"), "admin.export", null, undefined, c.get("ip"));
  return c.body(JSON.stringify({ exportedAt: new Date().toISOString(), version: c.env.APP_VERSION, tables: out }), 200, {
    "content-type": "application/json",
    "content-disposition": `attachment; filename="openmeet-instance-export.json"`,
  });
});
