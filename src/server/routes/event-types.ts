import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { eventTypeHosts, eventTypes, privateLinks, schedules, teamMembers, teams, type EventType } from "../../database/schema";
import type { AppEnv, AppVariables, SessionUser } from "../env";
import { badRequest, conflict } from "../lib/errors";
import { newId, newToken } from "../lib/ids";
import { parseJson } from "../lib/json";
import { readBody } from "../lib/validate";
import { eventTypeInputSchema, type EventTypeInput } from "../../shared/schemas";
import { audit } from "../services/audit";
import { requireEventType, requireTeam, visibleTeamIds } from "../services/permissions";
import { sha256Hex } from "../security/crypto";
import { DAY } from "../../shared/time";

type Db = AppVariables["db"];

export function serializeEventType(et: EventType, hosts: string[] = []) {
  return {
    ...et,
    durationOptions: parseJson<number[]>(et.durationOptions, []),
    locations: parseJson<unknown[]>(et.locations, []),
    questions: parseJson<unknown[]>(et.questions, []),
    hostUserIds: hosts,
  };
}

async function hostsOf(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, string[]>();
  const rows = await db.select().from(eventTypeHosts).where(inArray(eventTypeHosts.eventTypeId, ids));
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.eventTypeId, [...(map.get(r.eventTypeId) ?? []), r.userId]);
  return map;
}

export async function listEventTypes(db: Db, user: SessionUser) {
  const teamIds = await visibleTeamIds(db, user.id);
  const rows = await db
    .select()
    .from(eventTypes)
    .where(teamIds.length > 0 ? or(eq(eventTypes.ownerUserId, user.id), inArray(eventTypes.teamId, teamIds)) : eq(eventTypes.ownerUserId, user.id))
    .orderBy(desc(eventTypes.createdAt));
  const hosts = await hostsOf(db, rows.map((r) => r.id));
  const teamRows = teamIds.length > 0 ? await db.select({ id: teams.id, name: teams.name, slug: teams.slug }).from(teams).where(inArray(teams.id, teamIds)) : [];
  return rows.map((r) => ({ ...serializeEventType(r, hosts.get(r.id) ?? []), team: teamRows.find((t) => t.id === r.teamId) ?? null }));
}

async function validateRelations(db: Db, user: SessionUser, input: EventTypeInput, existing?: EventType) {
  const teamId = existing ? existing.teamId : (input.teamId ?? null);
  if (teamId) await requireTeam(db, user, teamId, "manage");
  if (!teamId && input.kind !== "one_on_one" && input.kind !== "group") throw badRequest("Collective and round-robin events must belong to a team");
  if (input.kind === "group" && input.seats < 2) throw badRequest("Group events need at least 2 seats");
  if (input.scheduleId) {
    const s = await db.select({ userId: schedules.userId }).from(schedules).where(eq(schedules.id, input.scheduleId)).get();
    if (!s || (!teamId && s.userId !== user.id)) throw badRequest("Unknown schedule");
  }
  let hostIds: string[] = [];
  if (teamId && input.hostUserIds && input.hostUserIds.length > 0) {
    const members = await db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
    const allowed = new Set(members.map((m) => m.userId));
    if (input.hostUserIds.some((h) => !allowed.has(h))) throw badRequest("All hosts must be members of the team");
    hostIds = [...new Set(input.hostUserIds)];
  }
  return { teamId, hostIds };
}

function values(input: EventTypeInput) {
  return {
    title: input.title,
    slug: input.slug,
    description: input.description ?? null,
    kind: input.kind,
    duration: input.duration,
    durationOptions: JSON.stringify(input.durationOptions.filter((d) => d !== input.duration)),
    color: input.color,
    locations: JSON.stringify(input.locations),
    scheduleId: input.scheduleId ?? null,
    slotInterval: input.slotInterval ?? null,
    minNoticeMinutes: input.minNoticeMinutes,
    bookingWindowDays: input.bookingWindowDays,
    bufferBefore: input.bufferBefore,
    bufferAfter: input.bufferAfter,
    maxPerDay: input.maxPerDay ?? null,
    maxPerWeek: input.maxPerWeek ?? null,
    seats: input.kind === "group" ? input.seats : 1,
    requiresConfirmation: input.requiresConfirmation,
    isPrivate: input.isPrivate,
    isActive: input.isActive,
    questions: JSON.stringify(input.questions),
    redirectUrl: input.redirectUrl ?? null,
    confirmationMessage: input.confirmationMessage ?? null,
    brandColor: input.brandColor ?? null,
  };
}

function isUniqueViolation(err: unknown) {
  return err instanceof Error && /UNIQUE/i.test(`${err.message} ${(err as { cause?: Error }).cause?.message ?? ""}`);
}

export const eventTypeRoutes = new Hono<AppEnv>();

eventTypeRoutes.get("/", async (c) => c.json({ eventTypes: await listEventTypes(c.get("db"), c.get("actor")!.user) }));

eventTypeRoutes.get("/:id", async (c) => {
  const db = c.get("db");
  const et = await requireEventType(db, c.get("actor")!.user, c.req.param("id"), "view");
  const hosts = await hostsOf(db, [et.id]);
  return c.json({ eventType: serializeEventType(et, hosts.get(et.id) ?? []) });
});

eventTypeRoutes.post("/", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const input = await readBody(c, eventTypeInputSchema);
  const { teamId, hostIds } = await validateRelations(db, user, input);
  const id = newId();
  const now = Date.now();
  try {
    await db.batch([
      db.insert(eventTypes).values({ id, ownerUserId: teamId ? null : user.id, teamId, ...values(input), createdAt: now, updatedAt: now }),
      ...hostIds.map((h, i) => db.insert(eventTypeHosts).values({ eventTypeId: id, userId: h, priority: hostIds.length - i })),
    ] as never);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("slug_taken", "You already use this URL slug.");
    throw err;
  }
  await audit(db, c.get("actor"), "event_type.created", { type: "event_type", id }, { title: input.title }, c.get("ip"));
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, id)).get();
  return c.json({ eventType: serializeEventType(et!, hostIds) }, 201);
});

eventTypeRoutes.put("/:id", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const et = await requireEventType(db, user, c.req.param("id"), "manage");
  const input = await readBody(c, eventTypeInputSchema);
  const { hostIds } = await validateRelations(db, user, input, et);
  try {
    await db.batch([
      db.update(eventTypes).set({ ...values(input), updatedAt: Date.now() }).where(eq(eventTypes.id, et.id)),
      db.delete(eventTypeHosts).where(eq(eventTypeHosts.eventTypeId, et.id)),
      ...hostIds.map((h, i) => db.insert(eventTypeHosts).values({ eventTypeId: et.id, userId: h, priority: hostIds.length - i })),
    ] as never);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("slug_taken", "You already use this URL slug.");
    throw err;
  }
  await audit(db, c.get("actor"), "event_type.updated", { type: "event_type", id: et.id }, undefined, c.get("ip"));
  const updated = await db.select().from(eventTypes).where(eq(eventTypes.id, et.id)).get();
  return c.json({ eventType: serializeEventType(updated!, hostIds) });
});

eventTypeRoutes.delete("/:id", async (c) => {
  const db = c.get("db");
  const et = await requireEventType(db, c.get("actor")!.user, c.req.param("id"), "manage");
  // Event types with bookings are deactivated instead of deleted to keep history.
  const hasBookings = await c.env.DB.prepare("SELECT 1 AS x FROM bookings WHERE event_type_id = ? LIMIT 1").bind(et.id).first();
  if (hasBookings) {
    await db.update(eventTypes).set({ isActive: false, slug: `${et.slug}-archived-${newId(4)}`, updatedAt: Date.now() }).where(eq(eventTypes.id, et.id));
  } else {
    await db.delete(eventTypes).where(eq(eventTypes.id, et.id));
  }
  await audit(db, c.get("actor"), "event_type.deleted", { type: "event_type", id: et.id }, { archived: !!hasBookings }, c.get("ip"));
  return c.json({ ok: true, archived: !!hasBookings });
});

eventTypeRoutes.post("/:id/duplicate", async (c) => {
  const db = c.get("db");
  const et = await requireEventType(db, c.get("actor")!.user, c.req.param("id"), "manage");
  const id = newId();
  const now = Date.now();
  await db.insert(eventTypes).values({ ...et, id, slug: `${et.slug}-copy-${newId(4)}`, title: `${et.title} (copy)`, createdAt: now, updatedAt: now });
  return c.json({ id }, 201);
});

// ---- One-time / private booking links --------------------------------------

eventTypeRoutes.get("/:id/links", async (c) => {
  const db = c.get("db");
  const et = await requireEventType(db, c.get("actor")!.user, c.req.param("id"), "manage");
  const links = await db.select().from(privateLinks).where(eq(privateLinks.eventTypeId, et.id)).orderBy(desc(privateLinks.createdAt));
  return c.json({ links: links.map(({ tokenHash: _t, ...l }) => l) });
});

eventTypeRoutes.post("/:id/links", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const et = await requireEventType(db, user, c.req.param("id"), "manage");
  const input = await readBody(c, z.object({ singleUse: z.boolean().default(true), expiresInDays: z.number().int().min(1).max(365).nullish() }));
  const token = newToken(18);
  const id = newId();
  await db.insert(privateLinks).values({
    id,
    eventTypeId: et.id,
    tokenHash: await sha256Hex(token),
    singleUse: input.singleUse,
    expiresAt: input.expiresInDays ? Date.now() + input.expiresInDays * DAY : null,
    createdBy: user.id,
    createdAt: Date.now(),
  });
  return c.json({ id, url: `${c.get("baseUrl")}/book/${token}` }, 201);
});

eventTypeRoutes.delete("/:id/links/:linkId", async (c) => {
  const db = c.get("db");
  const et = await requireEventType(db, c.get("actor")!.user, c.req.param("id"), "manage");
  await db.delete(privateLinks).where(and(eq(privateLinks.id, c.req.param("linkId")), eq(privateLinks.eventTypeId, et.id)));
  return c.json({ ok: true });
});

