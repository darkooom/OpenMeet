import type { Env } from "../env";
import { encryptString } from "../security/crypto";
import { enqueue } from "./jobs";
import type { RawEmailPayload } from "./notifications";

/** Queues a non-booking e-mail. The body (which may contain one-time links) is stored encrypted. */
export async function queueRawEmail(env: Env, to: string, subject: string, body: { html: string; text: string }, template: string, name?: string): Promise<void> {
  const payload: RawEmailPayload = { to, name, subject, template, bodyEnc: await encryptString(env.ENCRYPTION_KEY, JSON.stringify(body), "email-body") };
  await enqueue(env.DB, "email.raw", payload, { maxAttempts: 6 });
}
