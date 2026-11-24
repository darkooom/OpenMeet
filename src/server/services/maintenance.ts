import type { Env } from "../env";
import { DAY } from "../../shared/time";
import { getConfig } from "./settings";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../database/schema";

/** Periodic cleanup, run by the cron trigger (cheap, idempotent). */
export async function runMaintenance(env: Env): Promise<void> {
  const now = Date.now();
  const db = drizzle(env.DB, { schema });
  const cfg = await getConfig(db);
  const stmts = [
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - DAY),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").bind(now, now - 7 * DAY),
    env.DB.prepare("DELETE FROM verification_tokens WHERE expires_at < ?").bind(now - DAY),
    env.DB.prepare("DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated_at < ?").bind(now - 14 * DAY),
    env.DB.prepare("DELETE FROM email_log WHERE created_at < ?").bind(now - 90 * DAY),
    env.DB.prepare("DELETE FROM webhook_deliveries WHERE created_at < ?").bind(now - 30 * DAY),
  ];
  if (cfg.retentionDays && cfg.retentionDays >= 30) {
    // Data retention: anonymise attendees of bookings that ended before the retention window.
    const cutoff = now - cfg.retentionDays * DAY;
    stmts.push(
      env.DB.prepare(
        `UPDATE booking_attendees SET name = 'Deleted', email = 'deleted+' || id || '@invalid', answers = '{}', manage_token_enc = NULL
         WHERE email NOT LIKE 'deleted+%' AND booking_id IN (SELECT id FROM bookings WHERE end_at < ?)`,
      ).bind(cutoff),
      env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM routing_responses WHERE created_at < ?").bind(cutoff),
    );
  }
  await env.DB.batch(stmts);
}
