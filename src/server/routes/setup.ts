/**
 * First-run setup wizard API.
 *
 * Protection: the instance can only be initialised by someone who knows the
 * SETUP_TOKEN secret configured at deploy time. The token is sent in the
 * request body (never in a URL), compared in constant time, rate limited, and
 * never logged. Completion is atomic: the "setupCompleted" row is inserted
 * with a plain INSERT as the first statement of the same D1 transaction that
 * creates the admin – a second concurrent attempt fails on the primary key
 * and rolls back completely.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { eventTypes, instanceSettings, memberships, organizations, users } from "../../database/schema";
import type { AppEnv } from "../env";
import { AppError, forbidden } from "../lib/errors";
import { newId } from "../lib/ids";
import { readBody } from "../lib/validate";
import { emailSchema, localeSchema, passwordSchema, slugSchema, timezoneSchema, usernameSchema } from "../../shared/schemas";
import { buildCreateUser, createSession } from "../services/auth";
import { audit } from "../services/audit";
import { getConfig, setConfig, setCredentials } from "../services/settings";
import { isStrongSecret, timingSafeEqualStr } from "../security/crypto";
import { hitRateLimit } from "../security/rate-limit";

export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get("/status", async (c) => {
  const cfg = await getConfig(c.get("db"));
  return c.json({
    setupCompleted: cfg.setupCompleted,
    setupTokenConfigured: isStrongSecret(c.env.SETUP_TOKEN),
    encryptionKeyConfigured: isStrongSecret(c.env.ENCRYPTION_KEY),
    detectedBaseUrl: new URL(c.req.url).origin,
  });
});

async function checkToken(c: Context<AppEnv>, token: string) {
  const ok = await hitRateLimit(c.env.DB, "setup", c.get("ip"), 10, 900);
  if (!ok) throw new AppError(429, "rate_limited", "Too many attempts. Try again in 15 minutes.");
  if (!isStrongSecret(c.env.SETUP_TOKEN)) throw new AppError(503, "setup_token_missing", "SETUP_TOKEN is not configured (min. 32 characters). Set it as a Worker secret and reload.");
  if (!isStrongSecret(c.env.ENCRYPTION_KEY)) throw new AppError(503, "encryption_key_missing", "ENCRYPTION_KEY is not configured (min. 32 characters).");
  if (!timingSafeEqualStr(token, c.env.SETUP_TOKEN)) throw forbidden("Invalid setup token");
}

setupRoutes.post("/verify", async (c) => {
  const cfg = await getConfig(c.get("db"));
  if (cfg.setupCompleted) throw new AppError(410, "setup_completed", "Setup has already been completed.");
  const { token } = await readBody(c, z.object({ token: z.string().min(1).max(500) }));
  await checkToken(c, token);
  return c.json({ ok: true });
});

const completeSchema = z.object({
  token: z.string().min(1).max(500),
  admin: z.object({ name: z.string().trim().min(1).max(120), email: emailSchema, username: usernameSchema, password: passwordSchema }),
  instance: z.object({
    productName: z.string().trim().min(1).max(60),
    defaultLocale: localeSchema,
    defaultTimezone: timezoneSchema,
    publicBaseUrl: z.string().url().max(300).refine((v) => /^https?:\/\//.test(v)).nullish(),
    registration: z.enum(["open", "invite_only", "closed"]).default("invite_only"),
  }),
  email: z
    .object({ provider: z.enum(["resend", "brevo", "postmark"]), apiKey: z.string().min(8).max(300), fromEmail: emailSchema, fromName: z.string().min(1).max(80) })
    .nullish(),
  google: z.object({ clientId: z.string().min(5).max(300), clientSecret: z.string().min(5).max(300) }).nullish(),
  microsoft: z.object({ clientId: z.string().min(5).max(300), clientSecret: z.string().min(5).max(300), tenant: z.string().max(100).default("common") }).nullish(),
  organization: z.object({ name: z.string().trim().min(1).max(120), slug: slugSchema }),
  eventType: z.object({ title: z.string().trim().min(1).max(120), slug: slugSchema, duration: z.number().int().min(5).max(720) }),
});

setupRoutes.post("/complete", async (c) => {
  const db = c.get("db");
  const cfg = await getConfig(db);
  if (cfg.setupCompleted) throw new AppError(410, "setup_completed", "Setup has already been completed.");
  const input = await readBody(c, completeSchema);
  await checkToken(c, input.token);

  const now = Date.now();
  const { userId, scheduleId, stmts } = await buildCreateUser(db, {
    email: input.admin.email,
    name: input.admin.name,
    username: input.admin.username,
    password: input.admin.password,
    timezone: input.instance.defaultTimezone,
    locale: input.instance.defaultLocale,
    isSuperAdmin: true,
    emailVerified: true,
  });
  const orgId = newId();
  try {
    await db.batch([
      // Atomic lock: fails with a PRIMARY KEY conflict if another request completed setup first.
      db.insert(instanceSettings).values({ key: "setupCompleted", value: "true", updatedAt: now }),
      ...stmts,
      db.insert(organizations).values({ id: orgId, name: input.organization.name, slug: input.organization.slug, createdAt: now, updatedAt: now }),
      db.insert(memberships).values({ orgId, userId, role: "owner", createdAt: now }),
      db.insert(eventTypes).values({
        id: newId(),
        ownerUserId: userId,
        title: input.eventType.title,
        slug: input.eventType.slug,
        duration: input.eventType.duration,
        locations: JSON.stringify([{ type: "jitsi" }]),
        color: "#1f7a5c",
        scheduleId,
        minNoticeMinutes: 120,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/UNIQUE|PRIMARY KEY/i.test(msg) && /instance_settings/i.test(msg)) throw new AppError(410, "setup_completed", "Setup has already been completed.");
    throw err;
  }
  await setConfig(db, {
    productName: input.instance.productName,
    defaultLocale: input.instance.defaultLocale,
    defaultTimezone: input.instance.defaultTimezone,
    publicBaseUrl: input.instance.publicBaseUrl ? input.instance.publicBaseUrl.replace(/\/+$/, "") : null,
    registration: input.instance.registration,
  });
  if (input.email) await setCredentials(db, c.env, "email", input.email);
  if (input.google) await setCredentials(db, c.env, "google", input.google);
  if (input.microsoft) await setCredentials(db, c.env, "microsoft", { ...input.microsoft, tenant: input.microsoft.tenant || "common" });
  await audit(db, { type: "system" }, "instance.setup_completed", { type: "user", id: userId }, { organization: input.organization.slug }, c.get("ip"));
  await createSession(c, userId);
  const user = await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get();
  return c.json({ ok: true, bookingUrl: `/u/${user?.username}/${input.eventType.slug}` });
});
