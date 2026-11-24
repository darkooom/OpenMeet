/**
 * Tenant isolation and role checks. Every route that touches a tenant-owned
 * resource resolves it through one of these helpers, which return 404 (not
 * 403) for foreign resources so that IDs of other tenants cannot be probed.
 */
import { and, eq, inArray } from "drizzle-orm";
import { bookingHosts, bookings, eventTypes, memberships, teamMembers, teams } from "../../database/schema";
import type { AppVariables, SessionUser } from "../env";
import { forbidden, notFound } from "../lib/errors";

type Db = AppVariables["db"];

export type OrgRole = "owner" | "admin" | "member";
export type TeamRole = "manager" | "member";

export async function orgRole(db: Db, userId: string, orgId: string): Promise<OrgRole | null> {
  const row = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId))).get();
  return row?.role ?? null;
}

export async function requireOrgRole(db: Db, user: SessionUser, orgId: string, roles: OrgRole[]): Promise<OrgRole> {
  const role = await orgRole(db, user.id, orgId);
  if (!role) throw notFound("Organization not found");
  if (!roles.includes(role)) throw forbidden();
  return role;
}

export async function teamAccess(db: Db, userId: string, teamId: string): Promise<{ team: typeof teams.$inferSelect; teamRole: TeamRole | null; orgRole: OrgRole | null } | null> {
  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!team) return null;
  const [tm, om] = await Promise.all([
    db.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).get(),
    orgRole(db, userId, team.orgId),
  ]);
  if (!om) return null; // not part of the tenant at all
  return { team, teamRole: tm?.role ?? null, orgRole: om };
}

/** View: any team member or org admin/owner. Manage: team manager or org admin/owner. */
export async function requireTeam(db: Db, user: SessionUser, teamId: string, level: "view" | "manage") {
  const access = await teamAccess(db, user.id, teamId);
  if (!access) throw notFound("Team not found");
  const isOrgAdmin = access.orgRole === "owner" || access.orgRole === "admin";
  if (level === "view" && !access.teamRole && !isOrgAdmin) throw notFound("Team not found");
  if (level === "manage" && access.teamRole !== "manager" && !isOrgAdmin) throw forbidden("Team manager role required");
  return access;
}

export async function requireEventType(db: Db, user: SessionUser, eventTypeId: string, level: "view" | "manage") {
  const et = await db.select().from(eventTypes).where(eq(eventTypes.id, eventTypeId)).get();
  if (!et) throw notFound("Event type not found");
  if (et.ownerUserId) {
    if (et.ownerUserId !== user.id) throw notFound("Event type not found");
    return et;
  }
  await requireTeam(db, user, et.teamId!, level);
  return et;
}

/** IDs of team event types the user can see (member) or manage. */
export async function visibleTeamIds(db: Db, userId: string): Promise<string[]> {
  const direct = await db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId));
  const adminOrgs = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), inArray(memberships.role, ["owner", "admin"])));
  const orgTeams =
    adminOrgs.length > 0 ? await db.select({ id: teams.id }).from(teams).where(inArray(teams.orgId, adminOrgs.map((o) => o.orgId))) : [];
  return [...new Set([...direct.map((d) => d.id), ...orgTeams.map((t) => t.id)])];
}

/** A booking is visible to its hosts and to managers of the owning team. */
export async function requireBooking(db: Db, user: SessionUser, bookingId: string, level: "view" | "manage") {
  const booking = await db.select().from(bookings).where(eq(bookings.id, bookingId)).get();
  if (!booking) throw notFound("Booking not found");
  const host = await db
    .select({ u: bookingHosts.userId })
    .from(bookingHosts)
    .where(and(eq(bookingHosts.bookingId, bookingId), eq(bookingHosts.userId, user.id)))
    .get();
  if (host || booking.organizerUserId === user.id) return booking;
  const et = await db.select({ teamId: eventTypes.teamId }).from(eventTypes).where(eq(eventTypes.id, booking.eventTypeId)).get();
  if (et?.teamId) {
    await requireTeam(db, user, et.teamId, level === "manage" ? "manage" : "view");
    return booking;
  }
  throw notFound("Booking not found");
}
