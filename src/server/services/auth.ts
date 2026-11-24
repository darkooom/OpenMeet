import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { apiKeys, availabilityRules, schedules, sessions, users, verificationTokens } from "../../database/schema";
import type { AppEnv, AppVariables, SessionUser } from "../env";
import { newId, newToken } from "../lib/ids";
import { parseJson } from "../lib/json";
import { hashPassword, sha256Hex } from "../security/crypto";
import { DAY, HOUR } from "../../shared/time";

type Db = AppVariables["db"];

export const SESSION_TTL = 30 * DAY;
const SECURE_COOKIE = "__Host-om_session";
const DEV_COOKIE = "om_session";

export function toSessionUser(u: typeof users.$inferSelect): SessionUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    username: u.username,
    timezone: u.timezone,
    locale: u.locale,
    isSuperAdmin: u.isSuperAdmin,
    emailVerified: u.emailVerifiedAt != null,
  };
}

function isHttps(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const token = newToken(32);
  const now = Date.now();
  await c.get("db").insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL,
    lastSeenAt: now,
    ip: c.get("ip").slice(0, 64),
    userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
  });
  const secure = isHttps(c);
  setCookie(c, secure ? SECURE_COOKIE : DEV_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
  return token;
}

export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SECURE_COOKIE) ?? getCookie(c, DEV_COOKIE);
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SECURE_COOKIE, { path: "/", secure: true });
  deleteCookie(c, DEV_COOKIE, { path: "/" });
}

export async function loadSession(db: Db, token: string): Promise<{ user: SessionUser; sessionId: string } | null> {
  const id = await sha256Hex(token);
  const now = Date.now();
  const row = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .get();
  if (!row || row.u.disabledAt) return null;
  if (now - row.s.lastSeenAt > HOUR) {
    await db.update(sessions).set({ lastSeenAt: now, expiresAt: now + SESSION_TTL }).where(eq(sessions.id, id));
  }
  return { user: toSessionUser(row.u), sessionId: id };
}

export async function loadApiKey(db: Db, raw: string): Promise<{ user: SessionUser; apiKeyId: string; scopes: string[] } | null> {
  if (!/^om_(live|svc)_[A-Za-z0-9_-]{20,}$/.test(raw)) return null;
  const hash = await sha256Hex(raw);
  const now = Date.now();
  const row = await db
    .select({ k: apiKeys, u: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .get();
  if (!row || row.u.disabledAt) return null;
  if (row.k.expiresAt && row.k.expiresAt < now) return null;
  if (!row.k.lastUsedAt || now - row.k.lastUsedAt > 5 * 60_000) {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.k.id));
  }
  return { user: toSessionUser(row.u), apiKeyId: row.k.id, scopes: parseJson<string[]>(row.k.scopes, []) };
}

export async function createApiKey(db: Db, userId: string, name: string, scopes: string[], kind: "user" | "service", expiresAt: number | null) {
  const raw = `om_${kind === "service" ? "svc" : "live"}_${newToken(24)}`;
  const id = newId();
  await db.insert(apiKeys).values({
    id,
    userId,
    name,
    kind,
    prefix: raw.slice(0, 12),
    keyHash: await sha256Hex(raw),
    scopes: JSON.stringify(scopes),
    expiresAt,
    createdAt: Date.now(),
  });
  return { id, key: raw };
}

export interface NewUserInput {
  email: string;
  name: string;
  username: string;
  password?: string | null;
  timezone: string;
  locale: string;
  isSuperAdmin?: boolean;
  emailVerified?: boolean;
}

/** Returns the statements that create a user with a default Mon–Fri 9–17 schedule. */
export async function buildCreateUser(db: Db, input: NewUserInput) {
  const now = Date.now();
  const userId = newId();
  const scheduleId = newId();
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const stmts = [
    db.insert(users).values({
      id: userId,
      email: input.email.toLowerCase(),
      name: input.name,
      username: input.username.toLowerCase(),
      passwordHash,
      timezone: input.timezone,
      locale: input.locale,
      isSuperAdmin: input.isSuperAdmin ?? false,
      emailVerifiedAt: input.emailVerified ? now : null,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(schedules).values({ id: scheduleId, userId, name: "Working hours", timezone: input.timezone, isDefault: true, createdAt: now, updatedAt: now }),
    ...[1, 2, 3, 4, 5].map((weekday) =>
      db.insert(availabilityRules).values({ id: newId(), scheduleId, weekday, startMinute: 9 * 60, endMinute: 17 * 60 }),
    ),
  ] as const;
  return { userId, scheduleId, stmts };
}

export async function issueToken(db: Db, purpose: "verify_email" | "reset_password", userId: string, ttlMs: number, data?: unknown): Promise<string> {
  const token = newToken(32);
  await db.insert(verificationTokens).values({
    tokenHash: await sha256Hex(token),
    userId,
    purpose,
    data: data ? JSON.stringify(data) : null,
    expiresAt: Date.now() + ttlMs,
    createdAt: Date.now(),
  });
  return token;
}

/** Atomically consumes a one-time token. Returns null if unknown, used or expired. */
export async function consumeToken(db: Db, purpose: string, token: string) {
  const hash = await sha256Hex(token);
  const now = Date.now();
  const row = await db
    .update(verificationTokens)
    .set({ usedAt: now })
    .where(and(eq(verificationTokens.tokenHash, hash), eq(verificationTokens.purpose, purpose), isNull(verificationTokens.usedAt), gt(verificationTokens.expiresAt, now)))
    .returning()
    .get();
  return row ?? null;
}

export async function usernameAvailable(db: Db, username: string): Promise<boolean> {
  const row = await db.select({ id: users.id }).from(users).where(eq(users.username, username.toLowerCase())).get();
  return !row;
}

export async function uniqueUsername(db: Db, base: string): Promise<string> {
  const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "user";
  if (await usernameAvailable(db, clean)) return clean;
  for (let i = 0; i < 20; i++) {
    const candidate = `${clean}-${Math.floor(Math.random() * 9000 + 1000)}`;
    if (await usernameAvailable(db, candidate)) return candidate;
  }
  return `${clean}-${newId(6)}`;
}
