import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq, isNull, gt, ne } from "drizzle-orm";
import { calendarConnections, invitations, memberships, oauthAccounts, organizations, sessions, teamMembers, users } from "../../database/schema";
import type { AppEnv } from "../env";
import { AppError, badRequest, conflict, forbidden, unauthorized } from "../lib/errors";
import { newId } from "../lib/ids";
import { readBody } from "../lib/validate";
import { emailSchema, localeSchema, passwordSchema, timezoneSchema, usernameSchema } from "../../shared/schemas";
import { DAY, HOUR } from "../../shared/time";
import {
  buildCreateUser,
  clearSessionCookie,
  consumeToken,
  createSession,
  issueToken,
  toSessionUser,
  uniqueUsername,
  usernameAvailable,
} from "../services/auth";
import { audit } from "../services/audit";
import { getConfig, credentialStatus } from "../services/settings";
import { hashPassword, sha256Hex, verifyPassword, encryptString } from "../security/crypto";
import { hitRateLimit, rateLimit } from "../security/rate-limit";
import { queueRawEmail } from "../services/mailer";
import { simpleEmail } from "../services/notifications";
import { callbackUrl, consumeState, decodeIdToken, exchangeCode, providerConfig, startAuthorization, type OAuthProvider } from "../integrations/oauth";
import { refreshCalendarList } from "../integrations/calendar";
import { requireSession } from "../middleware/context";

export const authRoutes = new Hono<AppEnv>();

async function sendVerification(c: Context<AppEnv>, userId: string, email: string, name: string) {
  const token = await issueToken(c.get("db"), "verify_email", userId, 2 * DAY);
  const cfg = await getConfig(c.get("db"));
  const body = simpleEmail(cfg.productName, "Confirm your e-mail address", [`Hi ${name},`, "please confirm your e-mail address to activate your booking pages."], {
    label: "Confirm e-mail",
    url: `${c.get("baseUrl")}/verify-email/${token}`,
  });
  await queueRawEmail(c.env, email, `Confirm your e-mail for ${cfg.productName}`, body, "verify_email", name);
}

authRoutes.get("/providers", async (c) => {
  const status = await credentialStatus(c.get("db"));
  const cfg = await getConfig(c.get("db"));
  return c.json({ google: status.google, microsoft: status.microsoft, registration: cfg.registration, productName: cfg.productName, setupCompleted: cfg.setupCompleted });
});

authRoutes.get("/me", async (c) => {
  const actor = c.get("actor");
  if (!actor) return c.json({ user: null });
  const db = c.get("db");
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, actor.user.id));
  const full = await db.select().from(users).where(eq(users.id, actor.user.id)).get();
  return c.json({
    user: { ...actor.user, bio: full?.bio ?? null, timeFormat: full?.timeFormat ?? "24h", brandColor: full?.brandColor ?? null, hasPassword: !!full?.passwordHash },
    organizations: orgs,
  });
});

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  username: usernameSchema.optional(),
  password: passwordSchema,
  timezone: timezoneSchema.default("UTC"),
  locale: localeSchema.default("en"),
  inviteToken: z.string().max(200).optional(),
});

authRoutes.post("/register", rateLimit("register", 10, 3600), async (c) => {
  const db = c.get("db");
  const cfg = await getConfig(db);
  if (!cfg.setupCompleted) throw new AppError(409, "setup_required", "Complete the setup wizard first.");
  const input = await readBody(c, registerSchema);
  let invite: typeof invitations.$inferSelect | undefined;
  if (input.inviteToken) {
    invite = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.tokenHash, await sha256Hex(input.inviteToken)), isNull(invitations.acceptedAt), gt(invitations.expiresAt, Date.now())))
      .get();
    if (!invite) throw new AppError(410, "invite_invalid", "This invitation is invalid or has expired.");
    if (invite.email.toLowerCase() !== input.email) throw badRequest("Please register with the e-mail address the invitation was sent to.");
  } else if (cfg.registration !== "open") {
    throw forbidden("Public registration is disabled on this instance. Ask an administrator for an invitation.");
  }
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).get();
  if (existing) throw conflict("email_taken", "An account with this e-mail already exists.");
  const username = input.username ?? (await uniqueUsername(db, input.email.split("@")[0]!));
  if (!(await usernameAvailable(db, username))) throw conflict("username_taken", "This username is already taken.");
  const emailConfigured = (await credentialStatus(db)).email;
  // Invitation links prove ownership of the address; without a mail provider verification cannot be sent.
  const verified = !!invite || !cfg.requireEmailVerification || !emailConfigured;
  const { userId, stmts } = await buildCreateUser(db, { ...input, username, emailVerified: verified });
  const extra = invite ? await acceptInviteStatements(c, invite, userId) : [];
  await db.batch([...stmts, ...extra] as never);
  await audit(db, { type: "public" }, "user.registered", { type: "user", id: userId }, { via: invite ? "invite" : "open" }, c.get("ip"));
  if (!verified) await sendVerification(c, userId, input.email, input.name);
  await createSession(c, userId);
  return c.json({ ok: true, emailVerificationRequired: !verified }, 201);
});

async function acceptInviteStatements(c: Context<AppEnv>, invite: typeof invitations.$inferSelect, userId: string) {
  const db = c.get("db");
  const now = Date.now();
  const stmts: unknown[] = [
    db.update(invitations).set({ acceptedAt: now }).where(and(eq(invitations.id, invite.id), isNull(invitations.acceptedAt))),
    db
      .insert(memberships)
      .values({ orgId: invite.orgId, userId, role: invite.role === "admin" ? "admin" : "member", createdAt: now })
      .onConflictDoNothing(),
  ];
  if (invite.teamId) {
    stmts.push(db.insert(teamMembers).values({ teamId: invite.teamId, userId, role: invite.role === "manager" ? "manager" : "member", createdAt: now }).onConflictDoNothing());
  }
  return stmts;
}

authRoutes.post("/login", async (c) => {
  const db = c.get("db");
  const input = await readBody(c, z.object({ email: emailSchema, password: z.string().min(1).max(200) }));
  const ipOk = await hitRateLimit(c.env.DB, "login-ip", c.get("ip"), 30, 900);
  const acctOk = await hitRateLimit(c.env.DB, "login-acct", input.email, 10, 900);
  if (!ipOk || !acctOk) throw new AppError(429, "rate_limited", "Too many login attempts. Please wait 15 minutes.");
  const user = await db.select().from(users).where(eq(users.email, input.email)).get();
  const valid = await verifyPassword(input.password, user?.passwordHash);
  if (!user || !valid) {
    await audit(db, { type: "public" }, "auth.login_failed", null, { email: input.email }, c.get("ip"));
    throw unauthorized("Invalid e-mail or password");
  }
  if (user.disabledAt) throw forbidden("This account has been disabled.");
  await createSession(c, user.id);
  await audit(db, { type: "user", user: toSessionUser(user), sessionId: "" }, "auth.login", { type: "user", id: user.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  const actor = c.get("actor");
  if (actor?.type === "user") await c.get("db").update(sessions).set({ revokedAt: Date.now() }).where(eq(sessions.id, actor.sessionId));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.post("/verify-email", async (c) => {
  const { token } = await readBody(c, z.object({ token: z.string().min(10).max(200) }));
  const row = await consumeToken(c.get("db"), "verify_email", token);
  if (!row?.userId) throw new AppError(410, "token_invalid", "This link is invalid or has expired.");
  await c.get("db").update(users).set({ emailVerifiedAt: Date.now(), updatedAt: Date.now() }).where(eq(users.id, row.userId));
  return c.json({ ok: true });
});

authRoutes.post("/resend-verification", requireSession, rateLimit("resend-verify", 3, 3600, "actor"), async (c) => {
  const u = c.get("actor")!.user;
  if (u.emailVerified) return c.json({ ok: true });
  await sendVerification(c, u.id, u.email, u.name);
  return c.json({ ok: true });
});

authRoutes.post("/forgot-password", rateLimit("forgot", 5, 3600), async (c) => {
  const db = c.get("db");
  const { email } = await readBody(c, z.object({ email: emailSchema }));
  const user = await db.select().from(users).where(eq(users.email, email)).get();
  if (user && !user.disabledAt) {
    const token = await issueToken(db, "reset_password", user.id, HOUR);
    const cfg = await getConfig(db);
    const body = simpleEmail(cfg.productName, "Reset your password", [`Hi ${user.name},`, "use the button below to choose a new password. The link is valid for one hour.", "If you did not request this, you can ignore this e-mail."], {
      label: "Choose a new password",
      url: `${c.get("baseUrl")}/reset-password/${token}`,
    });
    await queueRawEmail(c.env, user.email, `Reset your ${cfg.productName} password`, body, "reset_password", user.name);
  }
  // Same response whether or not the account exists (no user enumeration).
  return c.json({ ok: true });
});

authRoutes.post("/reset-password", rateLimit("reset", 10, 3600), async (c) => {
  const db = c.get("db");
  const input = await readBody(c, z.object({ token: z.string().min(10).max(200), password: passwordSchema }));
  const row = await consumeToken(db, "reset_password", input.token);
  if (!row?.userId) throw new AppError(410, "token_invalid", "This link is invalid or has expired.");
  const now = Date.now();
  await db.batch([
    db.update(users).set({ passwordHash: await hashPassword(input.password), emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, row.userId)),
    // Password reset revokes all existing sessions.
    db.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt))),
  ]);
  await audit(db, { type: "public" }, "auth.password_reset", { type: "user", id: row.userId }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

authRoutes.post("/change-password", requireSession, async (c) => {
  const db = c.get("db");
  const actor = c.get("actor")!;
  const input = await readBody(c, z.object({ currentPassword: z.string().max(200).optional(), newPassword: passwordSchema }));
  const user = await db.select().from(users).where(eq(users.id, actor.user.id)).get();
  if (user?.passwordHash && !(await verifyPassword(input.currentPassword ?? "", user.passwordHash))) throw forbidden("Current password is incorrect");
  const now = Date.now();
  const sessionId = actor.type === "user" ? actor.sessionId : "";
  await db.batch([
    db.update(users).set({ passwordHash: await hashPassword(input.newPassword), updatedAt: now }).where(eq(users.id, actor.user.id)),
    db.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, actor.user.id), isNull(sessions.revokedAt), ne(sessions.id, sessionId))),
  ]);
  await audit(db, actor, "auth.password_changed", { type: "user", id: actor.user.id }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

authRoutes.get("/sessions", requireSession, async (c) => {
  const actor = c.get("actor")!;
  const rows = await c
    .get("db")
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, actor.user.id), isNull(sessions.revokedAt), gt(sessions.expiresAt, Date.now())));
  return c.json({
    sessions: rows.map((s) => ({
      id: s.id.slice(0, 16),
      current: actor.type === "user" && s.id === actor.sessionId,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      userAgent: s.userAgent,
    })),
  });
});

authRoutes.post("/sessions/revoke", requireSession, async (c) => {
  const actor = c.get("actor")!;
  const { id, all } = await readBody(c, z.object({ id: z.string().max(64).optional(), all: z.boolean().optional() }));
  const db = c.get("db");
  const rows = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, actor.user.id), isNull(sessions.revokedAt)));
  const current = actor.type === "user" ? actor.sessionId : "";
  const targets = rows.filter((r) => (all ? r.id !== current : r.id.startsWith(id ?? "\u0000")));
  for (const t of targets) await db.update(sessions).set({ revokedAt: Date.now() }).where(and(eq(sessions.id, t.id), eq(sessions.userId, actor.user.id)));
  await audit(db, actor, "auth.sessions_revoked", null, { count: targets.length }, c.get("ip"));
  return c.json({ ok: true, revoked: targets.length });
});

// ---- Invitations -----------------------------------------------------------

authRoutes.get("/invitations/:token", async (c) => {
  const db = c.get("db");
  const inv = await db
    .select({ i: invitations, orgName: organizations.name })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(and(eq(invitations.tokenHash, await sha256Hex(c.req.param("token"))), isNull(invitations.acceptedAt), gt(invitations.expiresAt, Date.now())))
    .get();
  if (!inv) throw new AppError(410, "invite_invalid", "This invitation is invalid or has expired.");
  const account = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.i.email)).get();
  return c.json({ email: inv.i.email, organization: inv.orgName, role: inv.i.role, accountExists: !!account });
});

authRoutes.post("/invitations/:token/accept", requireSession, async (c) => {
  const db = c.get("db");
  const actor = c.get("actor")!;
  const inv = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.tokenHash, await sha256Hex(c.req.param("token"))), isNull(invitations.acceptedAt), gt(invitations.expiresAt, Date.now())))
    .get();
  if (!inv) throw new AppError(410, "invite_invalid", "This invitation is invalid or has expired.");
  if (inv.email.toLowerCase() !== actor.user.email.toLowerCase()) throw forbidden("This invitation was sent to a different e-mail address.");
  await db.batch((await acceptInviteStatements(c, inv, actor.user.id)) as never);
  await audit(db, actor, "org.invitation_accepted", { type: "organization", id: inv.orgId }, undefined, c.get("ip"));
  return c.json({ ok: true });
});

// ---- OAuth (login, calendar & Zoom connections) ----------------------------

export const oauthRoutes = new Hono<AppEnv>();

oauthRoutes.get("/:provider/start", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  if (!["google", "microsoft", "zoom"].includes(provider)) throw badRequest("Unknown provider");
  const purpose = (c.req.query("purpose") ?? "login") as "login" | "calendar" | "zoom";
  if (!["login", "calendar", "zoom"].includes(purpose)) throw badRequest("Unknown purpose");
  const actor = c.get("actor");
  if (purpose !== "login" && actor?.type !== "user") return c.redirect("/login");
  if (purpose === "login" && provider === "zoom") throw badRequest("Zoom cannot be used for sign-in");
  const ok = await hitRateLimit(c.env.DB, "oauth-start", c.get("ip"), 30, 600);
  if (!ok) throw new AppError(429, "rate_limited", "Too many requests");
  const url = await startAuthorization(c.get("db"), c.env, c.get("baseUrl"), {
    provider,
    purpose,
    userId: actor?.user.id,
    inviteToken: c.req.query("invite")?.slice(0, 200),
  });
  return c.redirect(url, 302);
});

function failRedirect(c: Context<AppEnv>, purpose: string, reason: string) {
  const target = purpose === "login" ? "/login" : "/app/integrations";
  return c.redirect(`${target}?error=${encodeURIComponent(reason)}`, 302);
}

oauthRoutes.get("/:provider/callback", async (c) => {
  const db = c.get("db");
  const provider = c.req.param("provider") as OAuthProvider;
  const state = await consumeState(db, c.req.query("state") ?? "");
  if (!state || state.provider !== provider) return failRedirect(c, "login", "invalid_state");
  if (c.req.query("error")) return failRedirect(c, state.purpose, "access_denied");
  const code = c.req.query("code");
  if (!code) return failRedirect(c, state.purpose, "missing_code");
  const cfg = await providerConfig(db, c.env, provider);
  if (!cfg) return failRedirect(c, state.purpose, "not_configured");
  let tokens;
  try {
    tokens = await exchangeCode(cfg, provider, code, state.verifier, callbackUrl(c.get("baseUrl"), provider));
  } catch {
    return failRedirect(c, state.purpose, "token_exchange_failed");
  }
  const claims = tokens.id_token ? decodeIdToken(tokens.id_token) : {};
  const subject = String(claims.sub ?? claims.oid ?? "");
  const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();

  if (state.purpose === "login") {
    if (!subject) return failRedirect(c, "login", "no_identity");
    const linked = await db.select().from(oauthAccounts).where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.providerAccountId, subject))).get();
    let userId = linked?.userId;
    if (!userId && email) {
      // Only Google asserts verified e-mails reliably; others are never auto-linked to existing accounts.
      const emailVerified = provider === "google" && claims.email_verified === true;
      const existing = await db.select().from(users).where(eq(users.email, email)).get();
      if (existing) {
        if (!emailVerified) return failRedirect(c, "login", "account_exists_use_password");
        userId = existing.id;
        await db.insert(oauthAccounts).values({ id: newId(), userId, provider, providerAccountId: subject, email, createdAt: Date.now() });
      } else {
        const inst = await getConfig(db);
        let invite: typeof invitations.$inferSelect | undefined;
        if (state.inviteToken) {
          invite = await db
            .select()
            .from(invitations)
            .where(and(eq(invitations.tokenHash, await sha256Hex(state.inviteToken)), isNull(invitations.acceptedAt), gt(invitations.expiresAt, Date.now())))
            .get();
          if (invite && invite.email.toLowerCase() !== email) invite = undefined;
        }
        if (inst.registration !== "open" && !invite) return failRedirect(c, "login", "registration_closed");
        const created = await buildCreateUser(db, {
          email,
          name: String(claims.name ?? email.split("@")[0]),
          username: await uniqueUsername(db, email.split("@")[0]!),
          timezone: inst.defaultTimezone,
          locale: inst.defaultLocale,
          emailVerified: emailVerified || !!invite,
        });
        userId = created.userId;
        const extra = invite ? await acceptInviteStatements(c, invite, userId) : [];
        await db.batch([
          ...created.stmts,
          db.insert(oauthAccounts).values({ id: newId(), userId, provider, providerAccountId: subject, email, createdAt: Date.now() }),
          ...extra,
        ] as never);
      }
    }
    if (!userId) return failRedirect(c, "login", "no_identity");
    const u = await db.select().from(users).where(eq(users.id, userId)).get();
    if (!u || u.disabledAt) return failRedirect(c, "login", "account_disabled");
    await createSession(c, userId);
    await audit(db, { type: "user", user: toSessionUser(u), sessionId: "" }, "auth.login_oauth", { type: "user", id: userId }, { provider }, c.get("ip"));
    return c.redirect("/app", 302);
  }

  // Connection flows must be completed by the same signed-in user that started them.
  const actor = c.get("actor");
  if (!actor || actor.user.id !== state.userId) return failRedirect(c, state.purpose, "session_mismatch");
  const now = Date.now();
  const id = newId();
  await db.insert(calendarConnections).values({
    id,
    userId: actor.user.id,
    provider: state.purpose === "zoom" ? "zoom" : (provider as "google" | "microsoft"),
    accountEmail: email || null,
    accessTokenEnc: await encryptString(c.env.ENCRYPTION_KEY, tokens.access_token, "calendar"),
    refreshTokenEnc: tokens.refresh_token ? await encryptString(c.env.ENCRYPTION_KEY, tokens.refresh_token, "calendar") : null,
    expiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : null,
    scope: tokens.scope ?? null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  if (state.purpose === "calendar") {
    const conn = await db.select().from(calendarConnections).where(eq(calendarConnections.id, id)).get();
    try {
      if (conn) await refreshCalendarList(c.env, db, conn);
    } catch {
      await db.update(calendarConnections).set({ lastError: "Could not load calendar list" }).where(eq(calendarConnections.id, id));
    }
  }
  await audit(db, actor, "integration.connected", { type: "calendar_connection", id }, { provider, purpose: state.purpose }, c.get("ip"));
  return c.redirect(`/app/integrations?connected=${provider}`, 302);
});

