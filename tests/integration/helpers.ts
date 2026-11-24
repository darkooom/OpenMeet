import { SELF, env } from "cloudflare:test";
import { runDueJobs } from "../../src/server/services/jobs";
import { JOB_HANDLERS } from "../../src/server/services/job-handlers";
import type { Env } from "../../src/server/env";

export const BASE = "http://openmeet.test";
export const SETUP_TOKEN = "test-setup-token-0123456789abcdef";
export const ADMIN = { name: "Ada Admin", email: "admin@example.com", username: "ada", password: "correct-horse-42" };

export interface ApiResult<T = any> {
  status: number;
  json: T;
  headers: Headers;
  cookie: string | null;
}

export async function api<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string | null; headers?: Record<string, string>; raw?: boolean } = {},
): Promise<ApiResult<T>> {
  // A random client IP per request keeps the (IP based) rate limits out of the way of functional tests.
  const ip = `198.51.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  const headers: Record<string, string> = { "x-openmeet-csrf": "1", "cf-connecting-ip": ip, ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await SELF.fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, redirect: "manual" });
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie ? (/(om_session=[^;]+)/.exec(setCookie)?.[1] ?? null) : null;
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, headers: res.headers, cookie };
}

export async function ensureSetup(): Promise<string> {
  const status = await api("GET", "/api/setup/status");
  if (!status.json.setupCompleted) {
    const res = await api("POST", "/api/setup/complete", {
      body: {
        token: SETUP_TOKEN,
        admin: ADMIN,
        instance: { productName: "OpenMeet Test", defaultLocale: "en", defaultTimezone: "Europe/Berlin", publicBaseUrl: null, registration: "open" },
        organization: { name: "Acme", slug: "acme" },
        eventType: { title: "Intro call", slug: "intro", duration: 30 },
      },
    });
    if (res.status !== 200) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return login(ADMIN.email, ADMIN.password);
}

export async function login(email: string, password: string): Promise<string> {
  const res = await api("POST", "/api/auth/login", { body: { email, password } });
  if (res.status !== 200 || !res.cookie) throw new Error(`login failed ${res.status} ${JSON.stringify(res.json)}`);
  return res.cookie;
}

let counter = 0;
export async function registerUser(prefix = "user"): Promise<{ cookie: string; email: string; username: string; id: string }> {
  counter++;
  const unique = `${prefix.toLowerCase()}${Date.now().toString(36)}${counter}`;
  const email = `${unique}@example.com`;
  const res = await api("POST", "/api/auth/register", { body: { name: `User ${unique}`, email, username: unique, password: "password-1234", timezone: "Europe/Berlin" } });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.json)}`);
  const me = await api("GET", "/api/auth/me", { cookie: res.cookie });
  return { cookie: res.cookie!, email, username: unique, id: me.json.user.id };
}

/** Next Monday 00:00 Berlin, at least 3 days ahead (stable working-day slots). */
export function nextMondayBerlin(weeksAhead = 1): number {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay();
  const add = ((8 - dow) % 7 || 7) + (weeksAhead - 1) * 7;
  d.setUTCDate(d.getUTCDate() + add);
  // 00:00 Europe/Berlin is 22:00/23:00 UTC of the previous day; slots only matter from 09:00.
  return d.getTime() - 2 * 3600_000;
}

export async function drainJobs(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    const r = await runDueJobs(env as unknown as Env, JOB_HANDLERS, 50);
    if (r.processed === 0) break;
  }
}

export async function createEventType(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await api("POST", "/api/event-types", {
    cookie,
    body: { title: "Meeting", slug: `m-${Math.random().toString(36).slice(2, 8)}`, duration: 30, minNoticeMinutes: 0, bookingWindowDays: 60, locations: [{ type: "jitsi" }], ...overrides },
  });
  if (res.status !== 201) throw new Error(`create event type failed ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.eventType;
}

export async function firstSlot(eventTypeId: string, from = nextMondayBerlin(), cookie?: string, token?: string): Promise<number> {
  const res = await api("GET", `/api/public/event-types/${eventTypeId}/slots?from=${from}&to=${from + 5 * 86_400_000}${token ? `&token=${token}` : ""}`, { cookie });
  if (res.status !== 200 || res.json.slots.length === 0) throw new Error(`no slots ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  return res.json.slots[0].start;
}

export function bookingBody(eventTypeId: string, start: number, i = 0, extra: Record<string, unknown> = {}) {
  return { eventTypeId, start, name: `Guest ${i}`, email: `guest${i}@example.org`, timezone: "America/New_York", answers: {}, ...extra };
}

export { env };
