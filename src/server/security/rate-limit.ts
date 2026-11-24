import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { sha256Hex } from "./crypto";

/**
 * Fixed-window rate limiter stored in D1. The UPSERT ... RETURNING runs as a
 * single atomic statement, so concurrent requests are counted correctly.
 * The client IP is hashed – no raw IPs are persisted for rate limiting.
 */
export async function hitRateLimit(db: D1Database, bucket: string, identity: string, limit: number, windowSeconds: number): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000;
  const key = `${bucket}:${(await sha256Hex(`${bucket}|${identity}`)).slice(0, 32)}`;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

export function rateLimit(bucket: string, limit: number, windowSeconds: number, by: "ip" | "actor" = "ip"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get("actor");
    const identity = by === "actor" && actor ? `${actor.type}:${actor.type === "api_key" ? actor.apiKeyId : actor.user.id}` : c.get("ip");
    const ok = await hitRateLimit(c.env.DB, bucket, identity, limit, windowSeconds);
    if (!ok) {
      c.header("Retry-After", String(windowSeconds));
      throw new AppError(429, "rate_limited", "Too many requests. Please try again later.");
    }
    await next();
  };
}
