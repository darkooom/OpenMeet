/**
 * @openmeet/sdk – tiny, dependency-free TypeScript client for the OpenMeet REST API v1.
 *
 *   const om = new OpenMeet({ baseUrl: "https://meet.example.com", apiKey: process.env.OPENMEET_KEY! });
 *   const { data } = await om.availability({ eventTypeId, from: Date.now() });
 *   await om.createBooking({ eventTypeId, start: data.slots[0].startMs, name, email, timezone: "Europe/Berlin" }, { idempotencyKey: "crm-123" });
 *
 * Works in Node ≥ 18, Deno, Bun, browsers and Cloudflare Workers (uses global fetch).
 */

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "rejected";

export interface EventType {
  id: string;
  title: string;
  slug: string;
  kind: "one_on_one" | "group" | "collective" | "round_robin";
  duration: number;
  isActive: boolean;
  isPrivate: boolean;
}

export interface Slot {
  start: string;
  end: string;
  startMs: number;
}

export interface Booking {
  id: string;
  title: string;
  status: BookingStatus;
  startAt: number;
  endAt: number;
  meetingUrl: string | null;
  hosts: { id: string; name: string; email: string }[];
  attendees: { id: string; name: string; email: string; timezone: string; status: string }[];
}

export interface BookingInput {
  eventTypeId: string;
  start: number;
  duration?: number;
  name: string;
  email: string;
  timezone: string;
  locale?: "en" | "de";
  answers?: Record<string, string | string[] | boolean>;
  location?: { type: string; value?: string };
}

export class OpenMeetError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenMeetOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class OpenMeet {
  private readonly base: string;
  private readonly key: string;
  private readonly f: typeof fetch;

  constructor(opts: OpenMeetOptions) {
    this.base = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1`;
    this.key = opts.apiKey;
    this.f = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    if (!res.ok) throw new OpenMeetError(res.status, json.error?.code ?? "http_error", json.error?.message ?? `HTTP ${res.status}`);
    return json as T;
  }

  me() {
    return this.req<{ user: { id: string; name: string; email: string; timezone: string } }>("GET", "/me");
  }
  eventTypes() {
    return this.req<{ data: EventType[] }>("GET", "/event-types");
  }
  availability(q: { eventTypeId: string; from?: number; to?: number; duration?: number }) {
    const p = new URLSearchParams({ eventTypeId: q.eventTypeId });
    if (q.from) p.set("from", String(q.from));
    if (q.to) p.set("to", String(q.to));
    if (q.duration) p.set("duration", String(q.duration));
    return this.req<{ data: { eventTypeId: string; timezone: string; slots: Slot[] } }>("GET", `/availability?${p}`);
  }
  bookings(q: { status?: "upcoming" | "past" | "pending" | "cancelled" | "all"; limit?: number; cursor?: number } = {}) {
    const p = new URLSearchParams();
    if (q.status) p.set("status", q.status);
    if (q.limit) p.set("limit", String(q.limit));
    if (q.cursor) p.set("cursor", String(q.cursor));
    return this.req<{ data: Booking[]; nextCursor: number | null }>("GET", `/bookings?${p}`);
  }
  booking(id: string) {
    return this.req<{ data: Booking }>("GET", `/bookings/${encodeURIComponent(id)}`);
  }
  createBooking(input: BookingInput, opts: { idempotencyKey?: string } = {}) {
    return this.req<{ data: Booking; replay: boolean }>("POST", "/bookings", input, opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {});
  }
  cancelBooking(id: string, reason?: string) {
    return this.req<{ ok: true }>("POST", `/bookings/${encodeURIComponent(id)}/cancel`, { reason });
  }
  rescheduleBooking(id: string, start: number, reason?: string) {
    return this.req<{ ok: true; startAt: number; endAt: number }>("POST", `/bookings/${encodeURIComponent(id)}/reschedule`, { start, reason });
  }
  webhooks() {
    return this.req<{ data: { id: string; url: string; events: string[] }[] }>("GET", "/webhooks");
  }
  createWebhook(url: string, events: string[]) {
    return this.req<{ data: { id: string; url: string; events: string[]; secret: string } }>("POST", "/webhooks", { url, events });
  }

  /** Agent service API (service tokens with the "agent" scope). */
  readonly agent = {
    eventTypes: () => this.req<{ data: Pick<EventType, "id" | "title" | "slug" | "duration" | "kind">[] }>("GET", "/agent/event-types"),
    availability: (eventTypeId: string, from?: number, to?: number) =>
      this.req<{ data: { slots: Slot[]; timezone: string } }>("GET", `/agent/availability?eventTypeId=${encodeURIComponent(eventTypeId)}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),
    book: (input: BookingInput, idempotencyKey?: string) => this.req<{ data: Booking }>("POST", "/agent/bookings", input, idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    bookings: () => this.req<{ data: Booking[] }>("GET", "/agent/bookings"),
    cancel: (id: string, reason?: string) => this.req<{ ok: true }>("POST", `/agent/bookings/${encodeURIComponent(id)}/cancel`, { reason }),
    reschedule: (id: string, start: number) => this.req<{ ok: true }>("POST", `/agent/bookings/${encodeURIComponent(id)}/reschedule`, { start }),
    bookingLink: (eventTypeId: string, opts: { singleUse?: boolean; expiresInDays?: number } = {}) =>
      this.req<{ data: { url: string } }>("POST", "/agent/booking-links", { eventTypeId, ...opts }),
    agenda: (date?: string) => this.req<{ data: { date: string; timezone: string; count: number; bookings: Booking[] } }>("GET", `/agent/agenda${date ? `?date=${date}` : ""}`),
  };
}

/** Verifies the X-OpenMeet-Signature header of an incoming webhook (WebCrypto). */
export async function verifyWebhookSignature(secret: string, rawBody: string, header: string, toleranceSec = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const ts = Number(parts.t);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > toleranceSec || !parts.v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${rawBody}`)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
