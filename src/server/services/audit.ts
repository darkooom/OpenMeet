import { auditLogs } from "../../database/schema";
import type { Actor, AppVariables } from "../env";
import { newId } from "../lib/ids";
import { redact } from "../security/redact";

type Db = AppVariables["db"];

export async function audit(
  db: Db,
  actor: Actor | null | { type: "system" | "public"; id?: string },
  action: string,
  target?: { type: string; id: string } | null,
  meta?: Record<string, unknown>,
  ip?: string,
): Promise<void> {
  let actorType: "user" | "api_key" | "system" | "public" = "system";
  let actorId: string | null = null;
  if (actor && "user" in actor) {
    actorType = actor.type;
    actorId = actor.type === "api_key" ? actor.apiKeyId : actor.user.id;
  } else if (actor) {
    actorType = actor.type;
    actorId = actor.id ?? null;
  }
  try {
    await db.insert(auditLogs).values({
      id: newId(),
      actorType,
      actorId,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      ip: ip ?? null,
      meta: meta ? JSON.stringify(redact(meta)) : null,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error("audit log write failed", action, err instanceof Error ? err.message : "unknown");
  }
}
