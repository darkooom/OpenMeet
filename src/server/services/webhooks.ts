/**
 * Outgoing webhooks with HMAC-SHA256 signatures:
 *   X-OpenMeet-Signature: t=<unix seconds>,v1=<hex hmac of "<t>.<raw body>">
 * Receivers should reject timestamps older than 5 minutes.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../database/schema";
import { webhookDeliveries, webhooks } from "../../database/schema";
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { decryptString, hmacSha256Hex } from "../security/crypto";
import { redactString } from "../security/redact";
import { safeFetch } from "../security/ssrf";
import { bookingDetails } from "./booking";
import { PermanentJobError } from "./jobs";

export async function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export async function verifySignature(secret: string, body: string, header: string, toleranceSec = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const ts = Number(parts.t);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  return (await hmacSha256Hex(secret, `${ts}.${body}`)) === parts.v1;
}

export async function bookingWebhookPayload(env: Env, event: string, bookingId: string) {
  const db = drizzle(env.DB, { schema });
  const [details] = await bookingDetails(db, [bookingId]);
  return { id: newId(), event, createdAt: new Date().toISOString(), data: details ?? { id: bookingId } };
}

export async function deliverSigned(
  env: Env,
  opts: { url: string; secret: string | null; event: string; payload: unknown; webhookId?: string | null; workflowRunId?: string | null },
): Promise<{ ok: boolean; status: number | null; error?: string }> {
  const db = drizzle(env.DB, { schema });
  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "OpenMeet-Webhooks/1.0", "x-openmeet-event": opts.event };
  if (opts.secret) headers["x-openmeet-signature"] = await signPayload(opts.secret, body);
  let status: number | null = null;
  let error: string | undefined;
  let duration = 0;
  try {
    const res = await safeFetch(opts.url, { method: "POST", headers, body, timeoutMs: 10_000 });
    status = res.status;
    duration = res.durationMs;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = redactString(err instanceof Error ? err.message : String(err));
  }
  await db.insert(webhookDeliveries).values({
    id: newId(),
    webhookId: opts.webhookId ?? null,
    workflowRunId: opts.workflowRunId ?? null,
    url: opts.url,
    event: opts.event,
    statusCode: status,
    success: !error,
    error: error ?? null,
    durationMs: duration,
    createdAt: Date.now(),
  });
  return { ok: !error, status, error };
}

/** Job handler "webhook.deliver". */
export async function handleWebhookJob(env: Env, payload: { webhookId: string; event: string; bookingId: string }): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const hook = await db.select().from(webhooks).where(eq(webhooks.id, payload.webhookId)).get();
  if (!hook || !hook.isActive) return;
  const secret = await decryptString(env.ENCRYPTION_KEY, hook.secretEnc, "webhook");
  const body = await bookingWebhookPayload(env, payload.event, payload.bookingId);
  const res = await deliverSigned(env, { url: hook.url, secret, event: payload.event, payload: body, webhookId: hook.id });
  if (!res.ok) {
    if (res.status && res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) throw new PermanentJobError(res.error ?? "Webhook rejected");
    throw new Error(res.error ?? "Webhook delivery failed");
  }
}
