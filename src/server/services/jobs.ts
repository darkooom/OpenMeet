/**
 * Persistent job queue on D1, driven by the Cron Trigger (every minute) and
 * opportunistically via ctx.waitUntil right after the triggering request.
 *
 * - Claiming is a single atomic UPDATE ... RETURNING, so two concurrent
 *   runners never process the same job.
 * - Failed jobs are retried with exponential backoff + jitter, then marked
 *   "dead" (visible in Administration → Failed jobs, can be retried).
 * - dedupe_key makes enqueueing idempotent.
 */
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { redactString } from "../security/redact";

export interface JobRow {
  id: string;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  run_at: number;
}

export type JobHandler = (env: Env, payload: Record<string, unknown>, job: JobRow) => Promise<void>;

export interface EnqueueOptions {
  runAt?: number;
  dedupeKey?: string;
  maxAttempts?: number;
}

export function enqueueStatement(db: D1Database, type: string, payload: unknown, opts: EnqueueOptions = {}): D1PreparedStatement {
  const now = Date.now();
  return db
    .prepare(
      `INSERT OR IGNORE INTO jobs (id, type, payload, run_at, status, attempts, max_attempts, dedupe_key, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6, ?7, ?7)`,
    )
    .bind(newId(), type, JSON.stringify(payload), opts.runAt ?? now, opts.maxAttempts ?? 6, opts.dedupeKey ?? null, now);
}

export async function enqueue(db: D1Database, type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<void> {
  await enqueueStatement(db, type, payload, opts).run();
}

export function backoffMs(attempt: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 6 * 3600_000);
  return base + Math.floor(Math.random() * Math.min(base / 4, 60_000));
}

export async function claimJobs(db: D1Database, limit: number, now = Date.now()): Promise<JobRow[]> {
  const { results } = await db
    .prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = ?1, updated_at = ?2
       WHERE id IN (
         SELECT id FROM jobs
         WHERE (status = 'pending' AND run_at <= ?2) OR (status = 'running' AND locked_until < ?2)
         ORDER BY run_at LIMIT ?3
       )
       RETURNING id, type, payload, attempts, max_attempts, run_at`,
    )
    .bind(now + 5 * 60_000, now, limit)
    .all<JobRow>();
  return results;
}

export async function runDueJobs(env: Env, handlers: Record<string, JobHandler>, limit = 25): Promise<{ processed: number; failed: number }> {
  const jobs = await claimJobs(env.DB, limit);
  let failed = 0;
  for (const job of jobs) {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(env, JSON.parse(job.payload) as Record<string, unknown>, job);
      await env.DB.prepare("UPDATE jobs SET status = 'done', last_error = NULL, locked_until = NULL, updated_at = ? WHERE id = ?").bind(Date.now(), job.id).run();
    } catch (err) {
      failed++;
      const msg = redactString(err instanceof Error ? err.message : String(err));
      const dead = job.attempts >= job.max_attempts || err instanceof PermanentJobError;
      await env.DB.prepare("UPDATE jobs SET status = ?, last_error = ?, run_at = ?, locked_until = NULL, updated_at = ? WHERE id = ?")
        .bind(dead ? "dead" : "pending", msg, Date.now() + backoffMs(job.attempts), Date.now(), job.id)
        .run();
      console.warn(`job ${job.type} failed (attempt ${job.attempts})`, msg);
    }
  }
  return { processed: jobs.length, failed };
}

/** Throw to stop retrying (e.g. configuration missing, 4xx from provider). */
export class PermanentJobError extends Error {}
