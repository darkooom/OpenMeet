/**
 * OpenMeet Worker entry point: one Worker serves the JSON API, OAuth
 * callbacks and (via the ASSETS binding) the React single-page app.
 */
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Env } from "./env";
import { AppError } from "./lib/errors";
import { redactString } from "./security/redact";
import { csrf, initContext, loadActor, requireSession, requireSuperAdmin, requireUser } from "./middleware/context";
import { setupRoutes } from "./routes/setup";
import { authRoutes, oauthRoutes } from "./routes/auth";
import { eventTypeRoutes } from "./routes/event-types";
import { scheduleRoutes } from "./routes/schedules";
import { bookingRoutes } from "./routes/bookings";
import { publicRoutes } from "./routes/public";
import { meRoutes } from "./routes/me";
import { integrationRoutes } from "./routes/integrations";
import { automationRoutes } from "./routes/automation";
import { orgRoutes } from "./routes/orgs";
import { insightsRoutes } from "./routes/insights";
import { adminRoutes } from "./routes/admin";
import { v1Routes } from "./routes/v1";
import { runDueJobs } from "./services/jobs";
import { JOB_HANDLERS } from "./services/job-handlers";
import { runMaintenance } from "./services/maintenance";
import { ensureMigrated } from "../database/migrate";

const app = new Hono<AppEnv>();

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    crossOriginResourcePolicy: "same-origin",
    referrerPolicy: "strict-origin-when-cross-origin",
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
  }),
);

app.get("/healthz", async (c) => {
  try {
    await ensureMigrated(c.env.DB);
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, version: c.env.APP_VERSION ?? "dev" });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

app.use("/api/*", initContext, loadActor, csrf);
app.use("/auth/*", initContext, loadActor);

app.route("/api/setup", setupRoutes);
app.route("/api/auth", authRoutes);
app.route("/auth/oauth", oauthRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/v1", v1Routes);

// Dashboard API: interactive sessions only (API keys use /api/v1).
const dashboard: [string, Hono<AppEnv>][] = [
  ["/api/event-types", eventTypeRoutes],
  ["/api/schedules", scheduleRoutes],
  ["/api/bookings", bookingRoutes],
  ["/api/me", meRoutes],
  ["/api/integrations", integrationRoutes],
  ["/api/automation", automationRoutes],
  ["/api/orgs", orgRoutes],
  ["/api/insights", insightsRoutes],
];
for (const [path, routes] of dashboard) {
  app.use(path, requireUser, requireSession);
  app.use(`${path}/*`, requireUser, requireSession);
  app.route(path, routes);
}
app.use("/api/admin", requireSuperAdmin);
app.use("/api/admin/*", requireSuperAdmin);
app.route("/api/admin", adminRoutes);

app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Unknown endpoint" } }, 404));

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? undefined } }, err.status);
  }
  console.error("unhandled error", c.req.method, new URL(c.req.url).pathname, redactString(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)));
  return c.json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } }, 500);
});

// Everything else is the single-page app (served from static assets).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const res = app.fetch(request, env, ctx);
    // Opportunistically process queued jobs right after mutations (e-mails, calendar sync).
    if (request.method !== "GET" && new URL(request.url).pathname.startsWith("/api/") && !env.OPENMEET_TEST_MODE) {
      ctx.waitUntil(
        (async () => {
          await new Promise((r) => setTimeout(r, 50));
          await runDueJobs(env, JOB_HANDLERS, 10).catch(() => undefined);
        })(),
      );
    }
    return res;
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureMigrated(env.DB);
    ctx.waitUntil(runMaintenance(env).catch((e) => console.error("maintenance failed", redactString(String(e)))));
    // Drain due jobs in a few rounds (each claim is atomic, safe with concurrent runners).
    for (let i = 0; i < 4; i++) {
      const { processed } = await runDueJobs(env, JOB_HANDLERS, 25);
      if (processed < 25) break;
    }
  },
} satisfies ExportedHandler<Env>;

export { app };
