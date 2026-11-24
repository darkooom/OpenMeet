import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, isNull, like, or } from "drizzle-orm";
import {
  apiKeys,
  bookingAttendees,
  bookingHosts,
  bookings,
  calendarConnections,
  contacts,
  eventTypes,
  memberships,
  schedules,
  sessions,
  users,
  webhooks,
  workflows,
} from "../../database/schema";
import type { AppEnv } from "../env";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { readBody } from "../lib/validate";
import { API_SCOPES, colorSchema, localeSchema, timezoneSchema, usernameSchema } from "../../shared/schemas";
import { DAY } from "../../shared/time";
import { audit } from "../services/audit";
import { clearSessionCookie, createApiKey, usernameAvailable } from "../services/auth";
import { verifyPassword } from "../security/crypto";
import { cancelBooking } from "../services/booking";

export const meRoutes = new Hono<AppEnv>();

meRoutes.put("/profile", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const input = await readBody(
    c,
    z.object({
      name: z.string().trim().min(1).max(120),
      username: usernameSchema,
      timezone: timezoneSchema,
      locale: localeSchema,
      timeFormat: z.enum(["12h", "24h"]).default("24h"),
      bio: z.string().max(1000).nullish(),
      brandColor: colorSchema.nullish(),
      avatarUrl: z.string().url().max(500).refine((v) => v.startsWith("https://")).nullish(),
    }),
  );
  if (input.username !== user.username && !(await usernameAvailable(db, input.username))) throw conflict("username_taken", "This username is already taken.");
  await db
    .update(users)
    .set({ ...input, bio: input.bio ?? null, brandColor: input.brandColor ?? null, avatarUrl: input.avatarUrl ?? null, updatedAt: Date.now() })
    .where(eq(users.id, user.id));
  await audit(db, c.get("actor"), "user.profile_updated", { type: "user", id: user.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

// ---- API keys (incl. service tokens for AI agents) -------------------------

meRoutes.get("/api-keys", async (c) => {
  const rows = await c.get("db").select().from(apiKeys).where(eq(apiKeys.userId, c.get("actor")!.user.id)).orderBy(desc(apiKeys.createdAt));
  return c.json({ apiKeys: rows.map(({ keyHash: _h, ...k }) => ({ ...k, scopes: JSON.parse(k.scopes) as string[] })) });
});

meRoutes.post("/api-keys", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const input = await readBody(
    c,
    z.object({
      name: z.string().trim().min(1).max(80),
      kind: z.enum(["user", "service"]).default("user"),
      scopes: z.array(z.enum(API_SCOPES)).min(1),
      expiresInDays: z.number().int().min(1).max(730).nullish(),
    }),
  );
  const active = await db.select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt)));
  if (active.length >= 25) throw badRequest("Maximum number of API keys reached");
  const res = await createApiKey(db, user.id, input.name, input.scopes, input.kind, input.expiresInDays ? Date.now() + input.expiresInDays * DAY : null);
  await audit(db, c.get("actor"), "api_key.created", { type: "api_key", id: res.id }, { scopes: input.scopes, kind: input.kind }, c.get("ip"));
  return c.json({ id: res.id, key: res.key }, 201);
});

meRoutes.delete("/api-keys/:id", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const row = await db
    .update(apiKeys)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.userId, user.id)))
    .returning({ id: apiKeys.id })
    .get();
  if (!row) throw notFound("API key not found");
  await audit(db, c.get("actor"), "api_key.revoked", { type: "api_key", id: row.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

// ---- Contacts ---------------------------------------------------------------

meRoutes.get("/contacts", async (c) => {
  const db = c.get("db");
  const q = (c.req.query("q") ?? "").slice(0, 100);
  const user = c.get("actor")!.user;
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.ownerUserId, user.id), q ? or(like(contacts.name, `%${q}%`), like(contacts.email, `%${q}%`)) : undefined))
    .orderBy(desc(contacts.lastBookedAt))
    .limit(500);
  return c.json({ contacts: rows });
});

meRoutes.put("/contacts/:id", async (c) => {
  const db = c.get("db");
  const { notes } = await readBody(c, z.object({ notes: z.string().max(5000).nullish() }));
  const row = await db
    .update(contacts)
    .set({ notes: notes ?? null })
    .where(and(eq(contacts.id, c.req.param("id")), eq(contacts.ownerUserId, c.get("actor")!.user.id)))
    .returning({ id: contacts.id })
    .get();
  if (!row) throw notFound("Contact not found");
  return c.json({ ok: true });
});

meRoutes.delete("/contacts/:id", async (c) => {
  await c
    .get("db")
    .delete(contacts)
    .where(and(eq(contacts.id, c.req.param("id")), eq(contacts.ownerUserId, c.get("actor")!.user.id)));
  return c.json({ ok: true });
});

// ---- Privacy: data export & account deletion ------------------------------

meRoutes.get("/export", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const [profile, ets, scheds, hostRows, cts, conns, wfs, hooks, keys] = await Promise.all([
    db.select().from(users).where(eq(users.id, user.id)).get(),
    db.select().from(eventTypes).where(eq(eventTypes.ownerUserId, user.id)),
    db.select().from(schedules).where(eq(schedules.userId, user.id)),
    db.select({ bookingId: bookingHosts.bookingId }).from(bookingHosts).where(eq(bookingHosts.userId, user.id)),
    db.select().from(contacts).where(eq(contacts.ownerUserId, user.id)),
    db.select({ id: calendarConnections.id, provider: calendarConnections.provider, accountEmail: calendarConnections.accountEmail, createdAt: calendarConnections.createdAt }).from(calendarConnections).where(eq(calendarConnections.userId, user.id)),
    db.select().from(workflows).where(eq(workflows.ownerUserId, user.id)),
    db.select({ id: webhooks.id, url: webhooks.url, events: webhooks.events, createdAt: webhooks.createdAt }).from(webhooks).where(eq(webhooks.ownerUserId, user.id)),
    db.select({ id: apiKeys.id, name: apiKeys.name, scopes: apiKeys.scopes, createdAt: apiKeys.createdAt }).from(apiKeys).where(eq(apiKeys.userId, user.id)),
  ]);
  const bookingIds = hostRows.map((h) => h.bookingId);
  const bookingRows = [];
  for (let i = 0; i < bookingIds.length; i += 50) {
    const chunk = bookingIds.slice(i, i + 50);
    for (const id of chunk) {
      const b = await db.select().from(bookings).where(eq(bookings.id, id)).get();
      const a = await db
        .select({ name: bookingAttendees.name, email: bookingAttendees.email, timezone: bookingAttendees.timezone, answers: bookingAttendees.answers, status: bookingAttendees.status })
        .from(bookingAttendees)
        .where(eq(bookingAttendees.bookingId, id));
      if (b) bookingRows.push({ ...b, idempotencyKey: undefined, attendees: a });
    }
  }
  const { passwordHash: _p, ...safeProfile } = profile ?? ({} as Record<string, unknown>);
  await audit(db, c.get("actor"), "user.data_exported", { type: "user", id: user.id }, undefined, c.get("ip"));
  return c.body(
    JSON.stringify({ exportedAt: new Date().toISOString(), profile: safeProfile, eventTypes: ets, schedules: scheds, bookings: bookingRows, contacts: cts, calendarConnections: conns, workflows: wfs, webhooks: hooks, apiKeys: keys }, null, 2),
    200,
    { "content-type": "application/json", "content-disposition": `attachment; filename="openmeet-export-${user.username}.json"` },
  );
});

meRoutes.post("/delete-account", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor")!;
  const { password, confirm } = await readBody(c, z.object({ password: z.string().max(200).optional(), confirm: z.literal("DELETE") }));
  void confirm;
  const user = await db.select().from(users).where(eq(users.id, actor.user.id)).get();
  if (!user) throw notFound();
  if (user.passwordHash && !(await verifyPassword(password ?? "", user.passwordHash))) throw forbidden("Password is incorrect");
  const owned = await db.select({ orgId: memberships.orgId }).from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.role, "owner")));
  for (const o of owned) {
    const owners = await db.select({ u: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, o.orgId), eq(memberships.role, "owner")));
    const members = await db.select({ u: memberships.userId }).from(memberships).where(eq(memberships.orgId, o.orgId));
    if (owners.length === 1 && members.length > 1) throw badRequest("Transfer ownership of your organization before deleting your account.");
  }
  if (user.isSuperAdmin) {
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.isSuperAdmin, true));
    if (admins.length <= 1) throw badRequest("You are the only instance administrator. Promote another user first.");
  }
  // Cancel upcoming bookings so attendees are informed.
  const upcoming = await db
    .select({ id: bookings.id })
    .from(bookings)
    .innerJoin(bookingHosts, eq(bookingHosts.bookingId, bookings.id))
    .where(and(eq(bookingHosts.userId, user.id), eq(bookings.status, "confirmed")));
  for (const b of upcoming) {
    const booking = await db.select({ startAt: bookings.startAt }).from(bookings).where(eq(bookings.id, b.id)).get();
    if (booking && booking.startAt > Date.now()) await cancelBooking(c.env, db, b.id, { by: "organizer", reason: "The organizer's account was deleted." }).catch(() => undefined);
  }
  await audit(db, actor, "user.deleted", { type: "user", id: user.id }, undefined, c.get("ip"));
  await db.batch([db.delete(sessions).where(eq(sessions.userId, user.id)), db.delete(users).where(eq(users.id, user.id))]);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
