/**
 * HTTP-based e-mail providers that run on Workers (no SMTP sockets needed).
 * Configured in Settings → Administration → E-mail (stored encrypted in D1).
 */
import type { EmailCredentials } from "../../services/settings";

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** base64 */
  content: string;
}

export interface EmailMessage {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  idempotencyKey?: string;
}

export interface SendResult {
  provider: string;
  messageId: string | null;
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    public permanent: boolean,
  ) {
    super(message);
  }
}

async function check(provider: string, res: Response): Promise<Record<string, unknown>> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new EmailProviderError(`${provider} responded ${res.status}: ${String(json.message ?? json.name ?? "").slice(0, 200)}`, permanent);
  }
  return json;
}

export async function sendEmail(cfg: EmailCredentials, msg: EmailMessage): Promise<SendResult> {
  const from = `${cfg.fromName.replace(/[<>"]/g, "")} <${cfg.fromEmail}>`;
  switch (cfg.provider) {
    case "resend": {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          "content-type": "application/json",
          ...(msg.idempotencyKey ? { "Idempotency-Key": msg.idempotencyKey.slice(0, 256) } : {}),
        },
        body: JSON.stringify({
          from,
          to: [msg.to.email],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          reply_to: msg.replyTo,
          attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })),
        }),
      });
      const json = await check("Resend", res);
      return { provider: "resend", messageId: (json.id as string) ?? null };
    }
    case "brevo": {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": cfg.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: cfg.fromName, email: cfg.fromEmail },
          to: [{ email: msg.to.email, name: msg.to.name }],
          subject: msg.subject,
          htmlContent: msg.html,
          textContent: msg.text,
          replyTo: msg.replyTo ? { email: msg.replyTo } : undefined,
          attachment: msg.attachments?.map((a) => ({ name: a.filename, content: a.content })),
        }),
      });
      const json = await check("Brevo", res);
      return { provider: "brevo", messageId: (json.messageId as string) ?? null };
    }
    case "postmark": {
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "X-Postmark-Server-Token": cfg.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          From: from,
          To: msg.to.email,
          Subject: msg.subject,
          HtmlBody: msg.html,
          TextBody: msg.text,
          ReplyTo: msg.replyTo,
          MessageStream: "outbound",
          Attachments: msg.attachments?.map((a) => ({ Name: a.filename, Content: a.content, ContentType: a.contentType })),
        }),
      });
      const json = await check("Postmark", res);
      return { provider: "postmark", messageId: (json.MessageID as string) ?? null };
    }
    default:
      throw new EmailProviderError("Unknown e-mail provider", true);
  }
}
