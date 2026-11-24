#!/usr/bin/env node
/**
 * Regenerates the README images in docs/readme/ from the real application.
 *
 *   npm run build && node scripts/readme-screens.mjs
 *
 * Starts `wrangler dev` with an empty local database, completes the setup
 * wizard through the API, seeds fictional demo data (event types, a team,
 * bookings, a workflow, a routing form) and captures light + dark screenshots
 * with Playwright. Nothing touches a remote Cloudflare account.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const TOKEN = "readme-setup-token-0123456789abcdef01234567";
const OUT = resolve("docs/readme");
const STATE = `.wrangler/readme-${Date.now()}`;
mkdirSync(OUT, { recursive: true });

const server = spawn(
  "npx",
  ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE, "--var", `SETUP_TOKEN:${TOKEN}`, "--var", `ENCRYPTION_KEY:${"r".repeat(64)}`],
  { stdio: ["ignore", "ignore", "inherit"] },
);
const stop = () => server.kill("SIGTERM");
process.on("exit", stop);

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
}

const H = { "x-openmeet-csrf": "1", "content-type": "application/json" };
async function call(ctx, method, path, data) {
  const res = await ctx.fetch(`${BASE}${path}`, { method, headers: H, data });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return res.json();
}

async function seed(browser) {
  const ctx = await browser.newContext();
  const req = ctx.request;
  await call(req, "POST", "/api/setup/complete", {
    token: TOKEN,
    admin: { name: "Maya Lindqvist", email: "maya@northwind.example", username: "maya", password: "readme-demo-2026" },
    instance: { productName: "OpenMeet", defaultLocale: "en", defaultTimezone: "Europe/Berlin", publicBaseUrl: null, registration: "invite_only" },
    organization: { name: "Northwind Studio", slug: "northwind" },
    eventType: { title: "Intro call", slug: "intro", duration: 15 },
  });
  await call(req, "PUT", "/api/me/profile", { name: "Maya Lindqvist", username: "maya", timezone: "Europe/Berlin", locale: "en", timeFormat: "24h", bio: "Product designer at Northwind Studio. Pick a time that works for you." });

  const etList = await call(req, "GET", "/api/event-types");
  const intro = etList.eventTypes[0];
  await call(req, "PUT", `/api/event-types/${intro.id}`, { ...intro, description: "A quick hello to see if we are a good fit.", minNoticeMinutes: 60, color: "#1f7a5c", redirectUrl: "" });
  const mk = (body) => call(req, "POST", "/api/event-types", { minNoticeMinutes: 60, bookingWindowDays: 60, ...body }).then((r) => r.eventType);
  const support = await mk({ title: "30 min support", slug: "support", duration: 30, color: "#2f5bd3", description: "Screen-share session for questions about your project.", locations: [{ type: "jitsi" }], questions: [{ id: "topic", label: "What do you need help with?", type: "textarea", required: true }] });
  const onboarding = await mk({ title: "Onboarding workshop", slug: "onboarding", duration: 60, durationOptions: [90], color: "#7b4fd6", locations: [{ type: "in_person", value: "Northwind Studio, Torstraße 109, Berlin" }, { type: "jitsi" }], requiresConfirmation: true });
  await mk({ title: "Office hours", slug: "office-hours", duration: 45, kind: "group", seats: 8, color: "#c2410c", locations: [{ type: "jitsi" }] });
  await mk({ title: "Urgent technical issue", slug: "urgent", duration: 20, color: "#be185d", isPrivate: true, locations: [{ type: "phone", value: "+49 30 1234567" }] });

  // Lunch break in the default schedule + a holiday.
  const sched = (await call(req, "GET", "/api/schedules")).schedules[0];
  const holiday = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  await call(req, "PUT", `/api/schedules/${sched.id}`, {
    name: "Working hours",
    timezone: "Europe/Berlin",
    isDefault: true,
    weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, intervals: weekday === 5 ? [{ start: 540, end: 780 }] : [{ start: 540, end: 720 }, { start: 780, end: 1050 }] })),
    overrides: [{ date: holiday, kind: "unavailable", intervals: [], label: "Studio retreat" }],
  });
  await call(req, "POST", "/api/schedules", { name: "Evenings", timezone: "Europe/Berlin", weekly: [2, 4].map((weekday) => ({ weekday, intervals: [{ start: 1080, end: 1260 }] })), overrides: [] });

  // Team with two invited colleagues.
  const orgs = await call(req, "GET", "/api/orgs");
  const orgId = orgs.organizations[0].id;
  const team = await call(req, "POST", `/api/orgs/${orgId}/teams`, { name: "Customer Success", slug: "success" });
  for (const [name, email] of [
    ["Jonas Weber", "jonas@northwind.example"],
    ["Priya Nair", "priya@northwind.example"],
  ]) {
    const inv = await call(req, "POST", `/api/orgs/${orgId}/invitations`, { email, role: "member", teamId: team.id });
    const c = await browser.newContext();
    await call(c.request, "POST", "/api/auth/register", { name, email, password: "readme-demo-2026", inviteToken: inv.url.split("/invite/")[1], timezone: "Europe/Berlin" });
    await c.close();
  }
  await call(req, "POST", `/api/orgs/${orgId}/invitations`, { email: "leo@northwind.example", role: "member" });
  const rr = await mk({ title: "Customer kickoff", slug: "kickoff", duration: 45, kind: "round_robin", teamId: team.id, color: "#0e7490", locations: [{ type: "jitsi" }] });

  // Bookings from fictional guests over the next days.
  const guests = ["Lena Hoffmann", "Tom Becker", "Sara Okafor", "Lukas Brandt", "Emma Rossi", "Noah Kim", "Clara Schmidt", "Ben Adeyemi", "Mia Fischer", "Paul Laurent", "Hannah Wolf", "David Cohen"];
  const now = Date.now();
  let g = 0;
  for (const et of [intro, support, onboarding, rr, intro, support, rr]) {
    const slots = (await call(req, "GET", `/api/public/event-types/${et.id}/slots?from=${now}&to=${now + 9 * 86_400_000}`)).slots;
    for (const idx of [1, 7, 14]) {
      const s = slots[(idx + g * 3) % Math.max(slots.length, 1)];
      if (!s || g >= guests.length) continue;
      const name = guests[g];
      const pub = await browser.newContext();
      const res = await pub.request.post(`${BASE}/api/public/bookings`, {
        headers: H,
        data: {
          eventTypeId: et.id,
          start: s.start,
          name,
          email: `${name.split(" ")[0].toLowerCase()}@example.org`,
          timezone: "Europe/Berlin",
          answers: et.id === support.id ? { topic: "Setting up the shared calendar for our team." } : {},
          utm: g % 3 === 0 ? { utm_source: "newsletter", utm_campaign: "autumn-launch" } : undefined,
          source: g % 4 === 1 ? "embed" : undefined,
        },
      });
      await pub.close();
      if (res.ok()) g++;
    }
  }
  // One cancellation for realistic stats.
  const upcoming = await call(req, "GET", "/api/bookings?status=upcoming&limit=50");
  const victim = upcoming.bookings.at(-1);
  if (victim) await call(req, "POST", `/api/bookings/${victim.id}/cancel`, { reason: "Moved to next quarter" });
  // Page views so conversion is not empty.
  for (let i = 0; i < 37; i++) await req.post(`${BASE}/api/public/event-types/${intro.id}/view`, { headers: H });

  await call(req, "POST", "/api/automation/workflows", {
    name: "Remind attendees",
    trigger: "meeting.starting",
    offsetMinutes: 120,
    steps: [{ type: "send_email", to: "attendee", subject: "See you soon: {{event.title}}", body: "Hi {{attendee.name}},\n\nour meeting starts at {{booking.time}}.\n\nJoin: {{meeting.url}}" }],
  });
  await call(req, "POST", "/api/automation/workflows", {
    name: "Post new bookings to Slack",
    trigger: "booking.created",
    steps: [{ type: "slack", webhookUrl: "https://hooks.slack.com/services/T000/B000/DEMO", text: "New booking: {{attendee.name}} – {{event.title}} ({{booking.time}})" }],
  });
  await call(req, "POST", "/api/automation/routing-forms", {
    name: "How can we help?",
    description: "Answer one question and we will connect you with the right person.",
    fields: [{ id: "topic", label: "What is it about?", type: "select", required: true, options: ["Technical support", "Onboarding", "Sales", "Billing"] }],
    rules: [
      { id: "r1", conditions: [{ fieldId: "topic", op: "equals", value: "Technical support" }], target: { type: "event_type", eventTypeId: support.id } },
      { id: "r2", conditions: [{ fieldId: "topic", op: "equals", value: "Onboarding" }], target: { type: "event_type", eventTypeId: onboarding.id } },
    ],
    fallback: { type: "event_type", eventTypeId: intro.id },
  });
  await ctx.storageState({ path: `${STATE}/auth.json` });
  await ctx.close();
  return { introSlug: intro.slug };
}

async function shoot(browser, theme, shots) {
  const ctx = await browser.newContext({
    storageState: `${STATE}/auth.json`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    timezoneId: "Europe/Berlin",
    locale: "en-GB",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((t) => localStorage.setItem("om-theme", t), theme);
  const page = await ctx.newPage();
  for (const s of shots) {
    await page.goto(`${BASE}${s.path}`);
    await page.waitForLoadState("networkidle");
    if (s.before) await s.before(page);
    await page.waitForTimeout(400);
    let clip;
    if (s.card) {
      const box = await page.locator(s.card).first().boundingBox();
      if (box) clip = { x: Math.max(0, box.x - 32), y: Math.max(0, box.y - 32), width: box.width + 64, height: box.height + 64 };
    }
    await page.screenshot({ path: `${OUT}/${s.name}-${theme}.jpg`, type: "jpeg", quality: 82, fullPage: false, clip });
    console.log(`✓ ${s.name}-${theme}`);
  }
  await ctx.close();
}

async function mobile(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, timezoneId: "Europe/Berlin", locale: "en-GB", colorScheme: "light", reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("om-theme", "light"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/u/maya/support`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Next month" }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/mobile-booking.jpg`, type: "jpeg", quality: 82, fullPage: true });
  await page.locator("ul button").first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/mobile-form.jpg`, type: "jpeg", quality: 82 });
  console.log("✓ mobile");
  await ctx.close();
}

async function hero(browser) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:B;src:url("${BASE}/assets/")}
  body{margin:0;width:1600px;height:800px;background:#f7f8fa;font-family:"Bricolage Grotesque Variable","Instrument Sans Variable",system-ui,sans-serif;overflow:hidden;position:relative}
  .copy{position:absolute;left:96px;top:130px;width:540px}
  .logo{display:flex;align-items:center;gap:12px;font-weight:650;font-size:26px;color:#15171c}
  h1{font-size:60px;line-height:1.02;letter-spacing:-.03em;margin:44px 0 22px;color:#15171c;font-weight:650}
  p{font-family:"Instrument Sans Variable",system-ui,sans-serif;font-size:22px;line-height:1.5;color:#626a78;margin:0}
  .chips{display:flex;gap:10px;margin-top:34px;font-family:"Instrument Sans Variable",system-ui,sans-serif}
  .chip{border:1px solid #cfd4dc;border-radius:999px;padding:8px 16px;font-size:16px;color:#15171c;background:#fff}
  .shot{position:absolute;left:700px;top:150px;width:800px;border-radius:18px;box-shadow:0 30px 80px -30px rgba(20,30,40,.35),0 0 0 1px #e3e6ec}
  .phone{position:absolute;left:1330px;top:330px;width:220px;height:440px;object-fit:cover;object-position:top;border-radius:30px;box-shadow:0 30px 60px -20px rgba(20,30,40,.45),0 0 0 8px #15171c}
  </style></head><body>
  <div class="copy"><div class="logo"><svg viewBox="0 0 32 32" width="40" height="40"><rect width="32" height="32" rx="8" fill="#1f7a5c"/><circle cx="16" cy="16" r="8.5" fill="none" stroke="#fff" stroke-width="2.6"/><path d="M16 11.5V16l3 2" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>OpenMeet</div>
  <h1>Scheduling you own, on Cloudflare.</h1>
  <p>Open-source booking pages, team scheduling and calendar sync. One Worker, one D1 database, one click to deploy.</p>
  <div class="chips"><span class="chip">Self-hosted</span><span class="chip">AGPL-3.0</span><span class="chip">Free-plan friendly</span></div></div>
  <img class="shot" src="${BASE}/__readme/booking.jpg"><img class="phone" src="${BASE}/__readme/mobile.jpg">
  </body></html>`;
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const { readFileSync } = await import("node:fs");
  await page.route(`${BASE}/__readme/booking.jpg`, (r) => r.fulfill({ body: readFileSync(`${OUT}/booking-light.jpg`), contentType: "image/jpeg" }));
  await page.route(`${BASE}/__readme/mobile.jpg`, (r) => r.fulfill({ body: readFileSync(`${OUT}/mobile-booking.jpg`), contentType: "image/jpeg" }));
  await page.route(`${BASE}/__hero`, (r) => r.fulfill({ body: html, contentType: "text/html" }));
  // Load the app once so its self-hosted fonts are available, then render the hero on the same origin.
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState("networkidle");
  const css = await page.evaluate(() => [...document.styleSheets].map((s) => s.href).filter(Boolean));
  await page.goto(`${BASE}/__hero`);
  for (const href of css) await page.addStyleTag({ url: href });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/hero.jpg`, type: "jpeg", quality: 85 });
  console.log("✓ hero");
  await ctx.close();
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  await seed(browser);
  const shots = [
    {
      name: "booking",
      path: "/u/maya/support",
      card: "main div.rounded-\\[16px\\], #root div.rounded-\\[16px\\]",
      before: async (p) => {
        await p.getByRole("button", { name: "Next month" }).click();
        await p.waitForTimeout(500);
      },
    },
    { name: "dashboard", path: "/app" },
    { name: "event-types", path: "/app/event-types" },
    { name: "bookings", path: "/app/bookings" },
    { name: "availability", path: "/app/availability" },
    { name: "calendar", path: "/app/calendar", before: async (p) => p.getByRole("button", { name: "Next week" }).click() },
    { name: "workflows", path: "/app/workflows", before: async (p) => p.getByText("Remind attendees").click() },
    { name: "teams", path: "/app/teams" },
    { name: "analytics", path: "/app/analytics" },
    { name: "admin", path: "/app/admin" },
  ];
  for (const theme of ["light", "dark"]) await shoot(browser, theme, shots);
  await mobile(browser);
  await hero(browser);
  writeFileSync(`${OUT}/.generated`, `Generated by scripts/readme-screens.mjs on ${new Date().toISOString()}\n`);
  await browser.close();
} finally {
  stop();
}
