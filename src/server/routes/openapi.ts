/** OpenAPI 3.1 description of /api/v1 (served at /api/v1/openapi.json). */
import { API_SCOPES, WEBHOOK_EVENTS } from "../../shared/schemas";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema: object, description = "OK") => ({ description, content: { "application/json": { schema } } });
const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "409": { $ref: "#/components/responses/Error" },
  "422": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/Error" },
};
const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
const idem = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", minLength: 8, maxLength: 100 }, description: "Repeat-safe create: the same key returns the original booking." };
const pageParams = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
  { name: "cursor", in: "query", schema: { type: "integer" }, description: "Value of nextCursor from the previous page" },
];

function op(summary: string, scopes: string[], extra: Record<string, unknown> = {}) {
  return { summary, description: `Required scope: ${scopes.join(" or ")}`, security: [{ bearer: [] }], responses: { "200": ok({ type: "object" }), ...errors }, ...extra };
}

export function openApiSpec(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenMeet API",
      version: "1.0.0",
      description:
        "REST API of OpenMeet. Authenticate with `Authorization: Bearer <API key>`. Keys are created in Settings → API keys and carry scopes. Rate limit: 600 requests/minute per key. Times are UTC epoch milliseconds unless noted.",
      license: { name: "AGPL-3.0-only" },
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: `Scopes: ${API_SCOPES.join(", ")}` } },
      responses: { Error: { description: "Error", content: { "application/json": { schema: ref("Error") } } } },
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} }, required: ["code", "message"] } } },
        EventType: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            slug: { type: "string" },
            kind: { type: "string", enum: ["one_on_one", "group", "collective", "round_robin"] },
            duration: { type: "integer" },
            isActive: { type: "boolean" },
            isPrivate: { type: "boolean" },
          },
        },
        EventTypeInput: {
          type: "object",
          required: ["title", "slug", "duration"],
          properties: {
            title: { type: "string" },
            slug: { type: "string" },
            description: { type: "string" },
            kind: { type: "string", enum: ["one_on_one", "group"] },
            duration: { type: "integer", minimum: 5, maximum: 720 },
            locations: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } } } },
            minNoticeMinutes: { type: "integer" },
            bookingWindowDays: { type: "integer" },
            seats: { type: "integer" },
          },
        },
        Slot: { type: "object", properties: { start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" }, startMs: { type: "integer" } } },
        Booking: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["pending", "confirmed", "cancelled", "rejected"] },
            startAt: { type: "integer" },
            endAt: { type: "integer" },
            meetingUrl: { type: ["string", "null"] },
            attendees: { type: "array", items: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, timezone: { type: "string" } } } },
            hosts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } } } },
          },
        },
        BookingInput: {
          type: "object",
          required: ["eventTypeId", "start", "name", "email", "timezone"],
          properties: {
            eventTypeId: { type: "string" },
            start: { type: "integer", description: "UTC epoch ms of a slot returned by /availability" },
            duration: { type: "integer" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            timezone: { type: "string", example: "Europe/Berlin" },
            locale: { type: "string", enum: ["en", "de"] },
            answers: { type: "object", additionalProperties: true },
            location: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } } },
          },
        },
        Webhook: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, events: { type: "array", items: { type: "string", enum: [...WEBHOOK_EVENTS] } } } },
      },
    },
    paths: {
      "/me": { get: op("Current user", ["users:read", "agent"]) },
      "/users": { get: op("List users visible to the key (the key owner)", ["users:read"]) },
      "/event-types": {
        get: op("List event types", ["event_types:read", "agent"], { responses: { "200": ok({ type: "object", properties: { data: { type: "array", items: ref("EventType") } } }), ...errors } }),
        post: op("Create a personal event type", ["event_types:write"], { requestBody: { required: true, content: { "application/json": { schema: ref("EventTypeInput") } } } }),
      },
      "/event-types/{id}": { get: op("Get event type", ["event_types:read"], { parameters: [idParam] }), delete: op("Deactivate event type", ["event_types:write"], { parameters: [idParam] }) },
      "/availability": {
        get: op("Available slots", ["availability:read"], {
          parameters: [
            { name: "eventTypeId", in: "query", required: true, schema: { type: "string" } },
            { name: "from", in: "query", schema: { type: "integer" } },
            { name: "to", in: "query", schema: { type: "integer" } },
            { name: "duration", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": ok({ type: "object", properties: { data: { type: "object", properties: { slots: { type: "array", items: ref("Slot") } } } } }), ...errors },
        }),
      },
      "/bookings": {
        get: op("List bookings (cursor pagination)", ["bookings:read"], {
          parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["upcoming", "past", "pending", "cancelled", "all"] } }, ...pageParams],
          responses: { "200": ok({ type: "object", properties: { data: { type: "array", items: ref("Booking") }, nextCursor: { type: ["integer", "null"] } } }), ...errors },
        }),
        post: op("Create a booking", ["bookings:write"], { parameters: [idem], requestBody: { required: true, content: { "application/json": { schema: ref("BookingInput") } } } }),
      },
      "/bookings/{id}": { get: op("Get booking", ["bookings:read"], { parameters: [idParam] }) },
      "/bookings/{id}/cancel": { post: op("Cancel booking", ["bookings:write"], { parameters: [idParam], requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } } }) },
      "/bookings/{id}/reschedule": {
        post: op("Reschedule booking", ["bookings:write"], { parameters: [idParam], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["start"], properties: { start: { type: "integer" }, reason: { type: "string" } } } } } } }),
      },
      "/teams": { get: op("Teams of the key owner", ["teams:read"]) },
      "/calendars": { get: op("Connected calendars", ["calendars:read"]) },
      "/webhooks": {
        get: op("List webhooks", ["webhooks:read"]),
        post: op("Create webhook (returns signing secret once)", ["webhooks:write"], { requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url", "events"], properties: { url: { type: "string" }, events: { type: "array", items: { type: "string", enum: [...WEBHOOK_EVENTS] } } } } } } } }),
      },
      "/webhooks/{id}": { delete: op("Delete webhook", ["webhooks:write"], { parameters: [idParam] }) },
      "/agent/event-types": { get: op("Agent: list bookable event types", ["agent"]) },
      "/agent/availability": { get: op("Agent: available slots", ["agent"], { parameters: [{ name: "eventTypeId", in: "query", required: true, schema: { type: "string" } }] }) },
      "/agent/bookings": { get: op("Agent: list bookings", ["agent"]), post: op("Agent: book a slot", ["agent"], { parameters: [idem], requestBody: { required: true, content: { "application/json": { schema: ref("BookingInput") } } } }) },
      "/agent/bookings/{id}/cancel": { post: op("Agent: cancel", ["agent"], { parameters: [idParam] }) },
      "/agent/bookings/{id}/reschedule": { post: op("Agent: reschedule", ["agent"], { parameters: [idParam] }) },
      "/agent/booking-links": { post: op("Agent: create a (single-use) booking link", ["agent"]) },
      "/agent/agenda": { get: op("Agent: daily agenda", ["agent"], { parameters: [{ name: "date", in: "query", schema: { type: "string", format: "date" } }] }) },
    },
  };
}
