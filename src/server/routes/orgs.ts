import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { bookingHosts, bookings, eventTypes, invitations, memberships, organizations, teamMembers, teams, users } from "../../database/schema";
import type { AppEnv } from "../env";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { newId, newToken } from "../lib/ids";
import { readBody } from "../lib/validate";
import { colorSchema, emailSchema, slugSchema } from "../../shared/schemas";
import { DAY } from "../../shared/time";
import { audit } from "../services/audit";
import { requireOrgRole, requireTeam } from "../services/permissions";
import { sha256Hex } from "../security/crypto";
import { queueRawEmail } from "../services/mailer";
import { simpleEmail } from "../services/notifications";
import { getConfig } from "../services/settings";

export const orgRoutes = new Hono<AppEnv>();

function uniqueErr(err: unknown) {
  return err instanceof Error && /UNIQUE/i.test(`${err.message} ${(err as { cause?: Error }).cause?.message ?? ""}`);
}

orgRoutes.get("/", async (c) => {
  const db = c.get("db");
  const rows = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, brandColor: organizations.brandColor, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, c.get("actor")!.user.id));
  return c.json({ organizations: rows });
});

orgRoutes.post("/", async (c) => {
  const db = c.get("db");
  const user = c.get("actor")!.user;
  const input = await readBody(c, z.object({ name: z.string().trim().min(1).max(120), slug: slugSchema }));
  const id = newId();
  const now = Date.now();
  try {
    await db.batch([
      db.insert(organizations).values({ id, name: input.name, slug: input.slug, createdAt: now, updatedAt: now }),
      db.insert(memberships).values({ orgId: id, userId: user.id, role: "owner", createdAt: now }),
    ]);
  } catch (err) {
    if (uniqueErr(err)) throw conflict("slug_taken", "This organization URL is already taken.");
    throw err;
  }
  await audit(db, c.get("actor"), "org.created", { type: "organization", id }, undefined, c.get("ip"));
  return c.json({ id }, 201);
});

orgRoutes.get("/:orgId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  const role = await requireOrgRole(db, c.get("actor")!.user, orgId, ["owner", "admin", "member"]);
  const org = await db.select().from(organizations).where(eq(organizations.id, orgId)).get();
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, username: users.username, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId));
  const teamRows = await db.select().from(teams).where(eq(teams.orgId, orgId));
  const tm = teamRows.length > 0 ? await db.select().from(teamMembers).where(inArray(teamMembers.teamId, teamRows.map((t) => t.id))) : [];
  const invites =
    role === "member" ? [] : await db.select().from(invitations).where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt))).orderBy(desc(invitations.createdAt));
  return c.json({
    organization: org,
    role,
    members,
    teams: teamRows.map((t) => ({ ...t, members: tm.filter((m) => m.teamId === t.id).map((m) => ({ userId: m.userId, role: m.role })) })),
    invitations: invites.map(({ tokenHash: _t, ...i }) => i),
  });
});

orgRoutes.put("/:orgId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  await requireOrgRole(db, c.get("actor")!.user, orgId, ["owner", "admin"]);
  const input = await readBody(
    c,
    z.object({
      name: z.string().trim().min(1).max(120),
      slug: slugSchema,
      brandColor: colorSchema.nullish(),
      logoUrl: z.string().url().max(500).refine((v) => v.startsWith("https://")).nullish(),
    }),
  );
  try {
    await db
      .update(organizations)
      .set({ name: input.name, slug: input.slug, brandColor: input.brandColor ?? null, logoUrl: input.logoUrl ?? null, updatedAt: Date.now() })
      .where(eq(organizations.id, orgId));
  } catch (err) {
    if (uniqueErr(err)) throw conflict("slug_taken", "This organization URL is already taken.");
    throw err;
  }
  await audit(db, c.get("actor"), "org.updated", { type: "organization", id: orgId }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

orgRoutes.delete("/:orgId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  await requireOrgRole(db, c.get("actor")!.user, orgId, ["owner"]);
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await audit(db, c.get("actor"), "org.deleted", { type: "organization", id: orgId }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

async function createInvite(c: Context<AppEnv>, orgId: string, input: { email: string; role: string; teamId?: string | null }) {
  const db = c.get("db");
  const token = newToken(24);
  const id = newId();
  await db.insert(invitations).values({
    id,
    orgId,
    teamId: input.teamId ?? null,
    email: input.email,
    role: input.role,
    tokenHash: await sha256Hex(token),
    invitedBy: c.get("actor")!.user.id,
    expiresAt: Date.now() + 14 * DAY,
    createdAt: Date.now(),
  });
  const url = `${c.get("baseUrl")}/invite/${token}`;
  const org = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get();
  const cfg = await getConfig(db);
  const body = simpleEmail(cfg.productName, `You are invited to ${org?.name ?? "an organization"}`, [`${c.get("actor")!.user.name} invited you to join ${org?.name} on ${cfg.productName}.`, "The invitation is valid for 14 days."], {
    label: "Accept invitation",
    url,
  });
  await queueRawEmail(c.env, input.email, `Invitation to ${org?.name} on ${cfg.productName}`, body, "invitation");
  return { id, url };
}

orgRoutes.post("/:orgId/invitations", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  const user = c.get("actor")!.user;
  const input = await readBody(c, z.object({ email: emailSchema, role: z.enum(["admin", "member", "manager"]).default("member"), teamId: z.string().max(40).nullish() }));
  if (input.teamId) {
    const access = await requireTeam(db, user, input.teamId, "manage");
    if (access.team.orgId !== orgId) throw badRequest("Team belongs to another organization");
  } else {
    await requireOrgRole(db, user, orgId, ["owner", "admin"]);
    if (input.role === "manager") throw badRequest("The manager role requires a team");
  }
  const existingMember = await db
    .select({ u: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(users.email, input.email)))
    .get();
  if (existingMember && !input.teamId) throw conflict("already_member", "This person is already a member.");
  const res = await createInvite(c, orgId, input);
  await audit(db, c.get("actor"), "org.invitation_sent", { type: "organization", id: orgId }, { email: input.email, role: input.role }, c.get("ip"));
  return c.json(res, 201);
});

orgRoutes.delete("/:orgId/invitations/:id", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  await requireOrgRole(db, c.get("actor")!.user, orgId, ["owner", "admin"]);
  await db.delete(invitations).where(and(eq(invitations.id, c.req.param("id")), eq(invitations.orgId, orgId)));
  return c.json({ ok: true });
});

orgRoutes.put("/:orgId/members/:userId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  const actorRole = await requireOrgRole(db, c.get("actor")!.user, orgId, ["owner", "admin"]);
  const { role } = await readBody(c, z.object({ role: z.enum(["owner", "admin", "member"]) }));
  const target = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, c.req.param("userId")))).get();
  if (!target) throw notFound("Member not found");
  if (actorRole !== "owner" && (target.role === "owner" || role === "owner")) throw forbidden("Only owners can change ownership");
  if (target.role === "owner" && role !== "owner") {
    const owners = await db.select({ u: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner")));
    if (owners.length <= 1) throw badRequest("An organization needs at least one owner");
  }
  await db.update(memberships).set({ role }).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, target.userId)));
  await audit(db, c.get("actor"), "org.member_role_changed", { type: "user", id: target.userId }, { orgId, role }, c.get("ip"));
  return c.json({ ok: true });
});

orgRoutes.delete("/:orgId/members/:userId", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  const me = c.get("actor")!.user;
  const targetId = c.req.param("userId");
  if (targetId !== me.id) await requireOrgRole(db, me, orgId, ["owner", "admin"]);
  const target = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, targetId))).get();
  if (!target) throw notFound("Member not found");
  if (target.role === "owner") {
    const owners = await db.select({ u: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner")));
    if (owners.length <= 1) throw badRequest("An organization needs at least one owner");
  }
  const orgTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.orgId, orgId));
  await db.batch([
    db.delete(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, targetId))),
    ...(orgTeams.length > 0 ? [db.delete(teamMembers).where(and(eq(teamMembers.userId, targetId), inArray(teamMembers.teamId, orgTeams.map((t) => t.id))))] : []),
  ] as never);
  await audit(db, c.get("actor"), "org.member_removed", { type: "user", id: targetId }, { orgId }, c.get("ip"));
  return c.json({ ok: true });
});

// ---- Teams ------------------------------------------------------------------

orgRoutes.post("/:orgId/teams", async (c) => {
  const db = c.get("db");
  const orgId = c.req.param("orgId");
  const user = c.get("actor")!.user;
  await requireOrgRole(db, user, orgId, ["owner", "admin"]);
  const input = await readBody(c, z.object({ name: z.string().trim().min(1).max(120), slug: slugSchema, description: z.string().max(1000).nullish() }));
  const id = newId();
  const now = Date.now();
  try {
    await db.batch([
      db.insert(teams).values({ id, orgId, name: input.name, slug: input.slug, description: input.description ?? null, createdAt: now }),
      db.insert(teamMembers).values({ teamId: id, userId: user.id, role: "manager", createdAt: now }),
    ]);
  } catch (err) {
    if (uniqueErr(err)) throw conflict("slug_taken", "This team URL is already taken.");
    throw err;
  }
  await audit(db, c.get("actor"), "team.created", { type: "team", id }, undefined, c.get("ip"));
  return c.json({ id }, 201);
});

orgRoutes.get("/teams/:teamId", async (c) => {
  const db = c.get("db");
  const access = await requireTeam(db, c.get("actor")!.user, c.req.param("teamId"), "view");
  const teamId = access.team.id;
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, username: users.username, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId));
  const ets = await db.select({ id: eventTypes.id, title: eventTypes.title, slug: eventTypes.slug, kind: eventTypes.kind, isActive: eventTypes.isActive }).from(eventTypes).where(eq(eventTypes.teamId, teamId));
  const since = Date.now() - 30 * DAY;
  const stats =
    ets.length > 0
      ? await db
          .select({ userId: bookingHosts.userId, count: sql<number>`count(*)` })
          .from(bookingHosts)
          .innerJoin(bookings, eq(bookings.id, bookingHosts.bookingId))
          .where(and(inArray(bookings.eventTypeId, ets.map((e) => e.id)), gte(bookings.startAt, since), inArray(bookings.status, ["confirmed", "pending"])))
          .groupBy(bookingHosts.userId)
      : [];
  return c.json({
    team: access.team,
    canManage: access.teamRole === "manager" || access.orgRole === "owner" || access.orgRole === "admin",
    members: members.map((m) => ({ ...m, bookingsLast30Days: Number(stats.find((s) => s.userId === m.id)?.count ?? 0) })),
    eventTypes: ets,
  });
});

orgRoutes.put("/teams/:teamId", async (c) => {
  const db = c.get("db");
  const access = await requireTeam(db, c.get("actor")!.user, c.req.param("teamId"), "manage");
  const input = await readBody(c, z.object({ name: z.string().trim().min(1).max(120), slug: slugSchema, description: z.string().max(1000).nullish() }));
  try {
    await db.update(teams).set({ name: input.name, slug: input.slug, description: input.description ?? null }).where(eq(teams.id, access.team.id));
  } catch (err) {
    if (uniqueErr(err)) throw conflict("slug_taken", "This team URL is already taken.");
    throw err;
  }
  return c.json({ ok: true });
});

orgRoutes.delete("/teams/:teamId", async (c) => {
  const db = c.get("db");
  const access = await requireTeam(db, c.get("actor")!.user, c.req.param("teamId"), "view");
  if (access.orgRole !== "owner" && access.orgRole !== "admin") throw forbidden("Organization admin role required");
  await db.delete(teams).where(eq(teams.id, access.team.id));
  await audit(db, c.get("actor"), "team.deleted", { type: "team", id: access.team.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

orgRoutes.post("/teams/:teamId/members", async (c) => {
  const db = c.get("db");
  const access = await requireTeam(db, c.get("actor")!.user, c.req.param("teamId"), "manage");
  const input = await readBody(c, z.object({ userId: z.string().max(40), role: z.enum(["manager", "member"]).default("member") }));
  const isOrgMember = await db.select({ u: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, access.team.orgId), eq(memberships.userId, input.userId))).get();
  if (!isOrgMember) throw badRequest("The user must be a member of the organization");
  await db
    .insert(teamMembers)
    .values({ teamId: access.team.id, userId: input.userId, role: input.role, createdAt: Date.now() })
    .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId], set: { role: input.role } });
  await audit(db, c.get("actor"), "team.member_added", { type: "team", id: access.team.id }, { userId: input.userId, role: input.role }, c.get("ip"));
  return c.json({ ok: true });
});

orgRoutes.delete("/teams/:teamId/members/:userId", async (c) => {
  const db = c.get("db");
  const access = await requireTeam(db, c.get("actor")!.user, c.req.param("teamId"), "manage");
  await db.delete(teamMembers).where(and(eq(teamMembers.teamId, access.team.id), eq(teamMembers.userId, c.req.param("userId"))));
  return c.json({ ok: true });
});
