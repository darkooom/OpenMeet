import type { MiddlewareHandler } from "hono";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../database/schema";
import { ensureMigrated } from "../../database/migrate";
import type { Actor, AppEnv, Env } from "../env";
import { AppError, forbidden, unauthorized } from "../lib/errors";
import { newId } from "../lib/ids";
import { loadApiKey, loadSession, readSessionCookie } from "../services/auth";
import { getConfig, setConfig } from "../services/settings";

export function allowedHosts(env: Env, configuredBaseUrl: string | null): Set<string> | null {
  const extra = (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (extra.length === 0) return null; // host validation disabled until configured
  const set = new Set(extra);
  for (const u of [env.PUBLIC_BASE_URL, configuredBaseUrl]) {
    if (u) {
      try {
        set.add(new URL(u).host.toLowerCase());
      } catch {
        /* ignore */
      }
    }
  }
  return set;
}

/** Sets db, ip, request id and the canonical public base URL. */
export const initContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  await ensureMigrated(c.env.DB);
  const db = drizzle(c.env.DB, { schema });
  c.set("db", db);
  c.set("ip", c.req.header("cf-connecting-ip") ?? "0.0.0.0");
  c.set("requestId", c.req.header("cf-ray") ?? newId(10));
  const url = new URL(c.req.url);
  const cfg = await getConfig(db);
  const hosts = allowedHosts(c.env, cfg.publicBaseUrl);
  if (hosts && !hosts.has(url.host.toLowerCase())) {
    throw new AppError(400, "invalid_host", "Host not allowed");
  }
  const configured = cfg.publicBaseUrl || c.env.PUBLIC_BASE_URL || "";
  if (!configured && cfg.setupCompleted && cfg.lastSeenOrigin !== url.origin) {
    await setConfig(db, { lastSeenOrigin: url.origin });
  }
  c.set("baseUrl", (configured || url.origin).replace(/\/+$/, ""));
  c.set("actor", null);
  await next();
};

/** Resolves the actor from a session cookie or an API key. */
export const loadActor: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header("authorization");
  let actor: Actor | null = null;
  if (auth?.startsWith("Bearer ")) {
    const key = await loadApiKey(c.get("db"), auth.slice(7).trim());
    if (!key) throw unauthorized("Invalid or revoked API key");
    actor = { type: "api_key", user: key.user, apiKeyId: key.apiKeyId, scopes: key.scopes };
  } else {
    const token = readSessionCookie(c);
    if (token) {
      const s = await loadSession(c.get("db"), token);
      if (s) actor = { type: "user", user: s.user, sessionId: s.sessionId };
    }
  }
  c.set("actor", actor);
  await next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection for cookie-authenticated requests: mutations must be
 * same-origin (Origin / Sec-Fetch-Site) and carry a custom header that a
 * cross-site form cannot set without a CORS preflight (which we never grant).
 * Bearer-token requests are not affected by CSRF.
 */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || c.req.header("authorization")?.startsWith("Bearer ")) return next();
  const url = new URL(c.req.url);
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw forbidden("Cross-site request blocked");
  const origin = c.req.header("origin");
  if (origin && origin !== "null") {
    const o = new URL(origin);
    if (o.host !== url.host) throw forbidden("Cross-origin request blocked");
  }
  if (c.req.header("x-openmeet-csrf") !== "1") throw forbidden("Missing CSRF header");
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get("actor");
  if (!actor) throw unauthorized();
  await next();
};

/** Only interactive sessions (not API keys). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get("actor");
  if (!actor) throw unauthorized();
  if (actor.type !== "user") throw forbidden("This endpoint requires an interactive session");
  await next();
};

export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get("actor");
    if (!actor) throw unauthorized();
    if (actor.type === "api_key" && !actor.scopes.includes(scope)) throw forbidden(`API key lacks scope: ${scope}`);
    await next();
  };
}

export const requireSuperAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get("actor");
  if (!actor) throw unauthorized();
  if (actor.type !== "user" || !actor.user.isSuperAdmin) throw forbidden("Instance administrator access required");
  await next();
};

export function currentUser(c: { get: (k: "actor") => Actor | null }) {
  const actor = c.get("actor");
  if (!actor) throw unauthorized();
  return actor.user;
}
