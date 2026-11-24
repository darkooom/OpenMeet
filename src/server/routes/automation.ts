/** Workflows, outgoing webhooks and routing forms (dashboard side). */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { routingForms, routingResponses, webhookDeliveries, webhooks, workflowRuns, workflows } from "../../database/schema";
import type { AppEnv } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { newId, newToken } from "../lib/ids";
import { parseJson } from "../lib/json";
import { readBody } from "../lib/validate";
import { WEBHOOK_EVENTS, httpsUrlSchema, routingFormInputSchema, workflowInputSchema } from "../../shared/schemas";
import { audit } from "../services/audit";
import { encryptString, decryptString } from "../security/crypto";
import { assertSafeOutboundUrl } from "../security/ssrf";
import { deliverSigned } from "../services/webhooks";
import { listEventTypes } from "./event-types";

export const automationRoutes = new Hono<AppEnv>();

function checkUrls(steps: { type: string; url?: string; webhookUrl?: string }[]) {
  for (const s of steps) {
    const u = s.url ?? s.webhookUrl;
    if (!u) continue;
    try {
      assertSafeOutboundUrl(u);
    } catch (err) {
      throw badRequest(`Step ${s.type}: ${err instanceof Error ? err.message : "invalid URL"}`);
    }
  }
}

// ---- Workflows --------------------------------------------------------------

automationRoutes.get("/workflows", async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(workflows).where(eq(workflows.ownerUserId, c.get("actor")!.user.id)).orderBy(desc(workflows.createdAt));
  return c.json({ workflows: rows.map((w) => ({ ...w, steps: parseJson(w.steps, []), eventTypeIds: parseJson<string[] | null>(w.eventTypeIds, null) })) });
});

async function validateEventTypeIds(c: Context<AppEnv>, ids: string[] | null | undefined) {
  if (!ids || ids.length === 0) return null;
  const allowed = new Set((await listEventTypes(c.get("db"), c.get("actor")!.user)).map((e) => e.id));
  if (ids.some((id) => !allowed.has(id))) throw badRequest("Unknown event type");
  return ids;
}

automationRoutes.post("/workflows", async (c) => {
  const db = c.get("db");
  const input = await readBody(c, workflowInputSchema);
  checkUrls(input.steps);
  const ids = await validateEventTypeIds(c, input.eventTypeIds);
  const id = newId();
  const now = Date.now();
  await db.insert(workflows).values({
    id,
    ownerUserId: c.get("actor")!.user.id,
    name: input.name,
    trigger: input.trigger,
    eventTypeIds: ids ? JSON.stringify(ids) : null,
    offsetMinutes: input.offsetMinutes,
    steps: JSON.stringify(input.steps),
    isActive: input.isActive,
    createdAt: now,
    updatedAt: now,
  });
  await audit(db, c.get("actor"), "workflow.created", { type: "workflow", id }, undefined, c.get("ip"));
  return c.json({ id }, 201);
});

automationRoutes.put("/workflows/:id", async (c) => {
  const db = c.get("db");
  const input = await readBody(c, workflowInputSchema);
  checkUrls(input.steps);
  const ids = await validateEventTypeIds(c, input.eventTypeIds);
  const row = await db
    .update(workflows)
    .set({
      name: input.name,
      trigger: input.trigger,
      eventTypeIds: ids ? JSON.stringify(ids) : null,
      offsetMinutes: input.offsetMinutes,
      steps: JSON.stringify(input.steps),
      isActive: input.isActive,
      updatedAt: Date.now(),
    })
    .where(and(eq(workflows.id, c.req.param("id")), eq(workflows.ownerUserId, c.get("actor")!.user.id)))
    .returning({ id: workflows.id })
    .get();
  if (!row) throw notFound("Workflow not found");
  await audit(db, c.get("actor"), "workflow.updated", { type: "workflow", id: row.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

automationRoutes.delete("/workflows/:id", async (c) => {
  await c
    .get("db")
    .delete(workflows)
    .where(and(eq(workflows.id, c.req.param("id")), eq(workflows.ownerUserId, c.get("actor")!.user.id)));
  return c.json({ ok: true });
});

automationRoutes.get("/workflows/:id/runs", async (c) => {
  const db = c.get("db");
  const wf = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, c.req.param("id")), eq(workflows.ownerUserId, c.get("actor")!.user.id)))
    .get();
  if (!wf) throw notFound("Workflow not found");
  const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf.id)).orderBy(desc(workflowRuns.createdAt)).limit(50);
  return c.json({ runs: runs.map((r) => ({ ...r, log: parseJson(r.log, []) })) });
});

// ---- Webhooks ---------------------------------------------------------------

automationRoutes.get("/webhooks", async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(webhooks).where(eq(webhooks.ownerUserId, c.get("actor")!.user.id));
  const deliveries =
    rows.length > 0
      ? await db.select().from(webhookDeliveries).where(inArray(webhookDeliveries.webhookId, rows.map((r) => r.id))).orderBy(desc(webhookDeliveries.createdAt)).limit(50)
      : [];
  return c.json({ webhooks: rows.map(({ secretEnc: _s, ...w }) => ({ ...w, events: parseJson(w.events, []) })), deliveries });
});

const webhookInput = z.object({ url: httpsUrlSchema, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1), isActive: z.boolean().default(true) });

automationRoutes.post("/webhooks", async (c) => {
  const db = c.get("db");
  const input = await readBody(c, webhookInput);
  checkUrls([{ type: "webhook", url: input.url }]);
  const secret = `whsec_${newToken(24)}`;
  const id = newId();
  await db.insert(webhooks).values({
    id,
    ownerUserId: c.get("actor")!.user.id,
    url: input.url,
    secretEnc: await encryptString(c.env.ENCRYPTION_KEY, secret, "webhook"),
    events: JSON.stringify(input.events),
    isActive: input.isActive,
    createdAt: Date.now(),
  });
  await audit(db, c.get("actor"), "webhook.created", { type: "webhook", id }, { url: input.url }, c.get("ip"));
  return c.json({ id, secret }, 201);
});

automationRoutes.put("/webhooks/:id", async (c) => {
  const db = c.get("db");
  const input = await readBody(c, webhookInput);
  checkUrls([{ type: "webhook", url: input.url }]);
  const row = await db
    .update(webhooks)
    .set({ url: input.url, events: JSON.stringify(input.events), isActive: input.isActive })
    .where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.ownerUserId, c.get("actor")!.user.id)))
    .returning({ id: webhooks.id })
    .get();
  if (!row) throw notFound("Webhook not found");
  return c.json({ ok: true });
});

automationRoutes.post("/webhooks/:id/test", async (c) => {
  const db = c.get("db");
  const hook = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.ownerUserId, c.get("actor")!.user.id)))
    .get();
  if (!hook) throw notFound("Webhook not found");
  const secret = await decryptString(c.env.ENCRYPTION_KEY, hook.secretEnc, "webhook");
  const res = await deliverSigned(c.env, { url: hook.url, secret, event: "ping", payload: { id: newId(), event: "ping", createdAt: new Date().toISOString(), data: {} }, webhookId: hook.id });
  return c.json(res);
});

automationRoutes.delete("/webhooks/:id", async (c) => {
  await c
    .get("db")
    .delete(webhooks)
    .where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.ownerUserId, c.get("actor")!.user.id)));
  return c.json({ ok: true });
});

// ---- Routing forms ----------------------------------------------------------

async function checkTargets(c: Context<AppEnv>, targets: { type: string; eventTypeId?: string; url?: string }[]) {
  const allowed = new Set((await listEventTypes(c.get("db"), c.get("actor")!.user)).map((e) => e.id));
  for (const t of targets) {
    if (t.type === "event_type" && (!t.eventTypeId || !allowed.has(t.eventTypeId))) throw badRequest("Routing target references an unknown event type");
  }
}

automationRoutes.get("/routing-forms", async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(routingForms).where(eq(routingForms.ownerUserId, c.get("actor")!.user.id)).orderBy(desc(routingForms.createdAt));
  return c.json({
    forms: rows.map((f) => ({ ...f, fields: parseJson(f.fields, []), rules: parseJson(f.rules, []), fallback: parseJson(f.fallback, null) })),
  });
});

automationRoutes.post("/routing-forms", async (c) => {
  const db = c.get("db");
  const input = await readBody(c, routingFormInputSchema);
  await checkTargets(c, [...input.rules.map((r) => r.target), input.fallback]);
  const id = newId();
  const now = Date.now();
  await db.insert(routingForms).values({
    id,
    ownerUserId: c.get("actor")!.user.id,
    name: input.name,
    description: input.description ?? null,
    fields: JSON.stringify(input.fields),
    rules: JSON.stringify(input.rules),
    fallback: JSON.stringify(input.fallback),
    isActive: input.isActive,
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id }, 201);
});

automationRoutes.put("/routing-forms/:id", async (c) => {
  const db = c.get("db");
  const input = await readBody(c, routingFormInputSchema);
  await checkTargets(c, [...input.rules.map((r) => r.target), input.fallback]);
  const row = await db
    .update(routingForms)
    .set({
      name: input.name,
      description: input.description ?? null,
      fields: JSON.stringify(input.fields),
      rules: JSON.stringify(input.rules),
      fallback: JSON.stringify(input.fallback),
      isActive: input.isActive,
      updatedAt: Date.now(),
    })
    .where(and(eq(routingForms.id, c.req.param("id")), eq(routingForms.ownerUserId, c.get("actor")!.user.id)))
    .returning({ id: routingForms.id })
    .get();
  if (!row) throw notFound("Form not found");
  return c.json({ ok: true });
});

automationRoutes.delete("/routing-forms/:id", async (c) => {
  await c
    .get("db")
    .delete(routingForms)
    .where(and(eq(routingForms.id, c.req.param("id")), eq(routingForms.ownerUserId, c.get("actor")!.user.id)));
  return c.json({ ok: true });
});

automationRoutes.get("/routing-forms/:id/responses", async (c) => {
  const db = c.get("db");
  const f = await db
    .select({ id: routingForms.id })
    .from(routingForms)
    .where(and(eq(routingForms.id, c.req.param("id")), eq(routingForms.ownerUserId, c.get("actor")!.user.id)))
    .get();
  if (!f) throw notFound("Form not found");
  const rows = await db.select().from(routingResponses).where(eq(routingResponses.formId, f.id)).orderBy(desc(routingResponses.createdAt)).limit(200);
  return c.json({ responses: rows.map((r) => ({ ...r, answers: parseJson(r.answers, {}), target: parseJson(r.target, {}) })) });
});

