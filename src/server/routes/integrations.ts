import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { calendarConnections, calendars } from "../../database/schema";
import type { AppEnv } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { readBody } from "../lib/validate";
import { audit } from "../services/audit";
import { credentialStatus } from "../services/settings";
import { encryptString } from "../security/crypto";
import { assertSafeOutboundUrl } from "../security/ssrf";
import { ADAPTERS, refreshCalendarList, withCredentials } from "../integrations/calendar";

export const integrationRoutes = new Hono<AppEnv>();

integrationRoutes.get("/", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const conns = await db.select().from(calendarConnections).where(eq(calendarConnections.userId, user.id));
  const cals = conns.length > 0 ? await db.select().from(calendars).where(inArray(calendars.connectionId, conns.map((x) => x.id))) : [];
  const available = await credentialStatus(db);
  return c.json({
    available,
    connections: conns.map((x) => ({
      id: x.id,
      provider: x.provider,
      accountEmail: x.accountEmail,
      status: x.status,
      lastError: x.lastError,
      lastSyncedAt: x.lastSyncedAt,
      createdAt: x.createdAt,
      calendars: cals.filter((k) => k.connectionId === x.id).map((k) => ({ id: k.id, name: k.name, checkConflicts: k.checkConflicts, isTarget: k.isTarget, isPrimary: k.isPrimary })),
    })),
  });
});

async function ownConnection(c: Context<AppEnv>, id: string) {
  const conn = await c
    .get("db")
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, id), eq(calendarConnections.userId, c.get("actor")!.user.id)))
    .get();
  if (!conn) throw notFound("Connection not found");
  return conn;
}

integrationRoutes.post("/ics", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const input = await readBody(c, z.object({ name: z.string().trim().min(1).max(80), url: z.string().url().max(2000) }));
  const url = input.url.replace(/^webcal:/i, "https:");
  try {
    assertSafeOutboundUrl(url);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "Invalid URL");
  }
  const id = newId();
  const now = Date.now();
  await db.insert(calendarConnections).values({
    id,
    userId: user.id,
    provider: "ics",
    accountEmail: input.name,
    credentialsEnc: await encryptString(c.env.ENCRYPTION_KEY, JSON.stringify({ url, name: input.name }), "calendar"),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(calendars).values({ id: newId(), connectionId: id, externalId: "feed", name: input.name, checkConflicts: true, isTarget: false, isPrimary: true });
  await audit(db, c.get("actor"), "integration.connected", { type: "calendar_connection", id }, { provider: "ics" }, c.get("ip"));
  return c.json({ id }, 201);
});

integrationRoutes.post("/caldav", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const input = await readBody(c, z.object({ url: z.string().url().max(2000), username: z.string().min(1).max(200), password: z.string().min(1).max(500) }));
  try {
    assertSafeOutboundUrl(input.url);
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "Invalid URL");
  }
  const id = newId();
  const now = Date.now();
  await db.insert(calendarConnections).values({
    id,
    userId: user.id,
    provider: "caldav",
    accountEmail: input.username,
    credentialsEnc: await encryptString(c.env.ENCRYPTION_KEY, JSON.stringify(input), "calendar"),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const conn = (await db.select().from(calendarConnections).where(eq(calendarConnections.id, id)).get())!;
  try {
    await refreshCalendarList(c.env, db, conn);
  } catch (err) {
    await db.delete(calendarConnections).where(eq(calendarConnections.id, id));
    throw badRequest(`Could not connect to CalDAV server: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
  }
  await audit(db, c.get("actor"), "integration.connected", { type: "calendar_connection", id }, { provider: "caldav" }, c.get("ip"));
  return c.json({ id }, 201);
});

integrationRoutes.post("/:id/refresh", async (c) => {
  const conn = await ownConnection(c, c.req.param("id"));
  try {
    await refreshCalendarList(c.env, c.get("db"), conn);
    await c.get("db").update(calendarConnections).set({ lastError: null, lastSyncedAt: Date.now() }).where(eq(calendarConnections.id, conn.id));
  } catch (err) {
    throw badRequest(`Refresh failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
  }
  return c.json({ ok: true });
});

integrationRoutes.post("/:id/test", async (c) => {
  const conn = await ownConnection(c, c.req.param("id"));
  const adapter = ADAPTERS[conn.provider];
  if (!adapter) return c.json({ ok: true, busy: 0 });
  const cals = await c.get("db").select().from(calendars).where(eq(calendars.connectionId, conn.id));
  const ctx = await withCredentials(c.env, c.get("db"), conn);
  const busy = await adapter.freeBusy(ctx, cals.map((k) => k.externalId), Date.now(), Date.now() + 7 * 86_400_000);
  return c.json({ ok: true, busy: busy.length });
});

integrationRoutes.put("/calendars/:calendarId", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const input = await readBody(c, z.object({ checkConflicts: z.boolean().optional(), isTarget: z.boolean().optional() }));
  const row = await db
    .select({ cal: calendars, conn: calendarConnections })
    .from(calendars)
    .innerJoin(calendarConnections, eq(calendarConnections.id, calendars.connectionId))
    .where(and(eq(calendars.id, c.req.param("calendarId")), eq(calendarConnections.userId, user.id)))
    .get();
  if (!row) throw notFound("Calendar not found");
  if (input.isTarget && !ADAPTERS[row.conn.provider]?.canWrite) throw badRequest("This calendar is read-only");
  const stmts: unknown[] = [];
  if (input.isTarget) {
    const all = await db
      .select({ id: calendars.id })
      .from(calendars)
      .innerJoin(calendarConnections, eq(calendarConnections.id, calendars.connectionId))
      .where(eq(calendarConnections.userId, user.id));
    stmts.push(db.update(calendars).set({ isTarget: false }).where(inArray(calendars.id, all.map((a) => a.id))));
  }
  stmts.push(
    db
      .update(calendars)
      .set({ ...(input.checkConflicts !== undefined ? { checkConflicts: input.checkConflicts } : {}), ...(input.isTarget !== undefined ? { isTarget: input.isTarget } : {}) })
      .where(eq(calendars.id, row.cal.id)),
  );
  await db.batch(stmts as never);
  return c.json({ ok: true });
});

integrationRoutes.delete("/:id", async (c) => {
  const db = c.get("db");
  const conn = await ownConnection(c, c.req.param("id"));
  // Best effort token revocation at the provider.
  if (conn.provider === "google" && conn.accessTokenEnc) {
    try {
      const ctx = await withCredentials(c.env, db, conn);
      const token = await ctx.accessToken();
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" });
    } catch {
      /* ignore */
    }
  }
  await db.delete(calendarConnections).where(eq(calendarConnections.id, conn.id));
  await audit(db, c.get("actor"), "integration.disconnected", { type: "calendar_connection", id: conn.id }, { provider: conn.provider }, c.get("ip"));
  return c.json({ ok: true });
});
