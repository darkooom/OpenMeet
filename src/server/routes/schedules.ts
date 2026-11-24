import { Hono } from "hono";
import { and, eq, ne } from "drizzle-orm";
import { availabilityRules, dateOverrides, eventTypes, schedules } from "../../database/schema";
import type { AppEnv, AppVariables } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { readBody } from "../lib/validate";
import { scheduleInputSchema, type ScheduleInput } from "../../shared/schemas";
import { audit } from "../services/audit";
import { mergeIntervals } from "../services/slots";

type Db = AppVariables["db"];

export async function scheduleView(db: Db, id: string) {
  const s = await db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!s) return null;
  const [rules, overrides] = await Promise.all([
    db.select().from(availabilityRules).where(eq(availabilityRules.scheduleId, id)),
    db.select().from(dateOverrides).where(eq(dateOverrides.scheduleId, id)),
  ]);
  const weekly = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    intervals: rules
      .filter((r) => r.weekday === weekday)
      .map((r) => ({ start: r.startMinute, end: r.endMinute }))
      .sort((a, b) => a.start - b.start),
  }));
  const byDate = new Map<string, { date: string; kind: "available" | "unavailable"; intervals: { start: number; end: number }[]; label: string | null }>();
  for (const o of overrides) {
    const entry = byDate.get(o.date) ?? { date: o.date, kind: o.kind, intervals: [], label: o.label };
    if (o.kind === "unavailable" && o.startMinute == null) entry.kind = "unavailable";
    if (o.startMinute != null && o.endMinute != null) entry.intervals.push({ start: o.startMinute, end: o.endMinute });
    byDate.set(o.date, entry);
  }
  return {
    id: s.id,
    name: s.name,
    timezone: s.timezone,
    isDefault: s.isDefault,
    weekly,
    overrides: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function writeStatements(db: Db, scheduleId: string, input: ScheduleInput) {
  const stmts: unknown[] = [db.delete(availabilityRules).where(eq(availabilityRules.scheduleId, scheduleId)), db.delete(dateOverrides).where(eq(dateOverrides.scheduleId, scheduleId))];
  for (const day of input.weekly) {
    for (const i of mergeIntervals(day.intervals)) {
      stmts.push(db.insert(availabilityRules).values({ id: newId(), scheduleId, weekday: day.weekday, startMinute: i.start, endMinute: i.end }));
    }
  }
  for (const o of input.overrides) {
    if (o.kind === "unavailable" && o.intervals.length === 0) {
      stmts.push(db.insert(dateOverrides).values({ id: newId(), scheduleId, date: o.date, kind: "unavailable", label: o.label ?? null }));
    } else {
      for (const i of mergeIntervals(o.intervals)) {
        stmts.push(db.insert(dateOverrides).values({ id: newId(), scheduleId, date: o.date, kind: o.kind, startMinute: i.start, endMinute: i.end, label: o.label ?? null }));
      }
    }
  }
  return stmts;
}

export const scheduleRoutes = new Hono<AppEnv>();

scheduleRoutes.get("/", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const rows = await db.select().from(schedules).where(eq(schedules.userId, user.id));
  const views = await Promise.all(rows.map((r) => scheduleView(db, r.id)));
  return c.json({ schedules: views.filter(Boolean) });
});

scheduleRoutes.get("/:id", async (c) => {
  const db = c.get("db");
  const s = await db.select().from(schedules).where(and(eq(schedules.id, c.req.param("id")), eq(schedules.userId, c.get("actor")!.user.id))).get();
  if (!s) throw notFound("Schedule not found");
  return c.json({ schedule: await scheduleView(db, s.id) });
});

scheduleRoutes.post("/", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const input = await readBody(c, scheduleInputSchema);
  const id = newId();
  const now = Date.now();
  const count = await db.select({ id: schedules.id }).from(schedules).where(eq(schedules.userId, user.id));
  if (count.length >= 20) throw badRequest("You can have at most 20 schedules");
  const makeDefault = input.isDefault || count.length === 0;
  await db.batch([
    ...(makeDefault ? [db.update(schedules).set({ isDefault: false }).where(eq(schedules.userId, user.id))] : []),
    db.insert(schedules).values({ id, userId: user.id, name: input.name, timezone: input.timezone, isDefault: makeDefault, createdAt: now, updatedAt: now }),
    ...writeStatements(db, id, input),
  ] as never);
  await audit(db, c.get("actor"), "schedule.created", { type: "schedule", id }, undefined, c.get("ip"));
  return c.json({ schedule: await scheduleView(db, id) }, 201);
});

scheduleRoutes.put("/:id", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const s = await db.select().from(schedules).where(and(eq(schedules.id, c.req.param("id")), eq(schedules.userId, user.id))).get();
  if (!s) throw notFound("Schedule not found");
  const input = await readBody(c, scheduleInputSchema);
  await db.batch([
    ...(input.isDefault ? [db.update(schedules).set({ isDefault: false }).where(and(eq(schedules.userId, user.id), ne(schedules.id, s.id)))] : []),
    db
      .update(schedules)
      .set({ name: input.name, timezone: input.timezone, isDefault: input.isDefault ? true : s.isDefault, updatedAt: Date.now() })
      .where(eq(schedules.id, s.id)),
    ...writeStatements(db, s.id, input),
  ] as never);
  await audit(db, c.get("actor"), "schedule.updated", { type: "schedule", id: s.id }, undefined, c.get("ip"));
  return c.json({ schedule: await scheduleView(db, s.id) });
});

scheduleRoutes.delete("/:id", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const s = await db.select().from(schedules).where(and(eq(schedules.id, c.req.param("id")), eq(schedules.userId, user.id))).get();
  if (!s) throw notFound("Schedule not found");
  if (s.isDefault) throw badRequest("The default schedule cannot be deleted. Make another schedule the default first.");
  await db.batch([db.update(eventTypes).set({ scheduleId: null }).where(eq(eventTypes.scheduleId, s.id)), db.delete(schedules).where(eq(schedules.id, s.id))]);
  return c.json({ ok: true });
});
