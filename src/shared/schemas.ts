/** Validation schemas shared by the API and the web client. */
import { z } from "zod";
import { isValidTimeZone } from "./time";

export const timezoneSchema = z.string().refine(isValidTimeZone, "Invalid IANA time zone");
export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes");
export const usernameSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, "Use lowercase letters, numbers, dashes, dots or underscores");
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(10, "At least 10 characters")
  .max(200)
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), "Use letters and numbers");
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const localeSchema = z.enum(["en", "de"]);
export const httpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((v) => v.startsWith("https://"), "Must be an https:// URL");

export const LOCATION_TYPES = ["google_meet", "ms_teams", "zoom", "jitsi", "custom_video", "phone", "attendee_phone", "in_person"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const locationSchema = z.object({
  type: z.enum(LOCATION_TYPES),
  /** custom_video: URL, phone: organizer phone, in_person: address */
  value: z.string().max(500).optional(),
});
export type EventLocation = z.infer<typeof locationSchema>;

export const QUESTION_TYPES = ["text", "textarea", "select", "radio", "checkbox", "phone", "email"] as const;
export const questionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  label: z.string().min(1).max(200),
  type: z.enum(QUESTION_TYPES),
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(100)).max(30).optional(),
});
export type BookingQuestion = z.infer<typeof questionSchema>;

export const EVENT_KINDS = ["one_on_one", "group", "collective", "round_robin"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const eventTypeInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  slug: slugSchema,
  description: z.string().max(5000).nullish(),
  kind: z.enum(EVENT_KINDS).default("one_on_one"),
  teamId: z.string().nullish(),
  hostUserIds: z.array(z.string()).max(50).optional(),
  duration: z.number().int().min(5).max(720),
  durationOptions: z.array(z.number().int().min(5).max(720)).max(8).default([]),
  color: colorSchema.default("#1f7a5c"),
  locations: z.array(locationSchema).max(6).default([]),
  scheduleId: z.string().nullish(),
  slotInterval: z.number().int().min(5).max(720).nullish(),
  minNoticeMinutes: z.number().int().min(0).max(60 * 24 * 60).default(120),
  bookingWindowDays: z.number().int().min(1).max(730).default(60),
  bufferBefore: z.number().int().min(0).max(240).default(0),
  bufferAfter: z.number().int().min(0).max(240).default(0),
  maxPerDay: z.number().int().min(1).max(100).nullish(),
  maxPerWeek: z.number().int().min(1).max(500).nullish(),
  seats: z.number().int().min(1).max(1000).default(1),
  requiresConfirmation: z.boolean().default(false),
  isPrivate: z.boolean().default(false),
  isActive: z.boolean().default(true),
  questions: z.array(questionSchema).max(30).default([]),
  redirectUrl: httpsUrlSchema.nullish().or(z.literal("").transform(() => null)),
  confirmationMessage: z.string().max(2000).nullish(),
  brandColor: colorSchema.nullish(),
});
export type EventTypeInput = z.infer<typeof eventTypeInputSchema>;

export const intervalSchema = z
  .object({ start: z.number().int().min(0).max(1440), end: z.number().int().min(0).max(1440) })
  .refine((v) => v.end > v.start, "End must be after start");

export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: timezoneSchema,
  isDefault: z.boolean().optional(),
  /** weekday (0=Sunday) -> intervals in minutes */
  weekly: z.array(z.object({ weekday: z.number().int().min(0).max(6), intervals: z.array(intervalSchema).max(12) })).max(7),
  overrides: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        kind: z.enum(["available", "unavailable"]),
        intervals: z.array(intervalSchema).max(12).default([]),
        label: z.string().max(80).nullish(),
      }),
    )
    .max(400)
    .default([]),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const bookingRequestSchema = z.object({
  eventTypeId: z.string().min(1),
  start: z.number().int(),
  duration: z.number().int().optional(),
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  timezone: timezoneSchema,
  locale: localeSchema.optional(),
  location: z.object({ type: z.enum(LOCATION_TYPES), value: z.string().max(500).optional() }).optional(),
  answers: z.record(z.string(), z.union([z.string().max(5000), z.array(z.string().max(200)).max(30), z.boolean()])).default({}),
  privateLinkToken: z.string().max(200).optional(),
  routingResponseId: z.string().max(60).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
  source: z.string().max(60).optional(),
});
export type BookingRequest = z.infer<typeof bookingRequestSchema>;

export const WORKFLOW_TRIGGERS = [
  "booking.created",
  "booking.confirmed",
  "booking.cancelled",
  "booking.rescheduled",
  "meeting.starting",
  "meeting.completed",
  "booking.no_show",
] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

export const workflowStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send_email"),
    to: z.enum(["attendee", "organizer", "custom"]),
    customTo: emailSchema.optional(),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20000),
  }),
  z.object({ type: z.literal("delay"), minutes: z.number().int().min(1).max(60 * 24 * 30) }),
  z.object({ type: z.literal("webhook"), url: httpsUrlSchema, secret: z.string().max(200).optional() }),
  z.object({ type: z.literal("slack"), webhookUrl: httpsUrlSchema, text: z.string().min(1).max(3000) }),
  z.object({ type: z.literal("ms_teams"), webhookUrl: httpsUrlSchema, text: z.string().min(1).max(3000) }),
  z.object({
    type: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: httpsUrlSchema,
    headers: z.record(z.string(), z.string().max(1000)).optional(),
    body: z.string().max(20000).optional(),
  }),
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: z.enum(WORKFLOW_TRIGGERS),
  eventTypeIds: z.array(z.string()).max(100).nullish(),
  offsetMinutes: z.number().int().min(0).max(60 * 24 * 14).default(0),
  steps: z.array(workflowStepSchema).min(1).max(20),
  isActive: z.boolean().default(true),
});

export const routingFieldSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  label: z.string().min(1).max(200),
  type: z.enum(["text", "textarea", "select", "multi", "email"]),
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(100)).max(50).optional(),
});
export const routingTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event_type"), eventTypeId: z.string() }),
  z.object({ type: z.literal("url"), url: httpsUrlSchema }),
  z.object({ type: z.literal("message"), message: z.string().min(1).max(2000) }),
]);
export type RoutingTarget = z.infer<typeof routingTargetSchema>;
export const routingConditionSchema = z.object({
  fieldId: z.string(),
  op: z.enum(["equals", "not_equals", "contains", "in", "is_empty", "not_empty"]),
  value: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]).optional(),
});
export const routingRuleSchema = z.object({
  id: z.string().max(40),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(routingConditionSchema).min(1).max(20),
  target: routingTargetSchema,
});
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export const routingFormInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullish(),
  fields: z.array(routingFieldSchema).min(1).max(30),
  rules: z.array(routingRuleSchema).max(50),
  fallback: routingTargetSchema,
  isActive: z.boolean().default(true),
});

export const API_SCOPES = [
  "event_types:read",
  "event_types:write",
  "bookings:read",
  "bookings:write",
  "availability:read",
  "teams:read",
  "users:read",
  "calendars:read",
  "webhooks:read",
  "webhooks:write",
  "agent",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const WEBHOOK_EVENTS = ["booking.created", "booking.confirmed", "booking.cancelled", "booking.rescheduled", "booking.no_show"] as const;
