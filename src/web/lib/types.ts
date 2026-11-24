export interface BookingDetails {
  id: string;
  title: string;
  status: "pending" | "confirmed" | "cancelled" | "rejected";
  startAt: number;
  endAt: number;
  locationType: string | null;
  locationValue: string | null;
  meetingUrl: string | null;
  cancelReason: string | null;
  noShow: boolean;
  source: string | null;
  utm: Record<string, string> | null;
  createdAt: number;
  eventType: { id: string; title: string; slug: string; color: string; kind: string; teamId: string | null };
  hosts: { id: string; name: string; email: string }[];
  attendees: { id: string; name: string; email: string; timezone: string; status: string; noShow: boolean; answers: Record<string, unknown> }[];
}

export interface EventTypeDto {
  id: string;
  ownerUserId: string | null;
  teamId: string | null;
  title: string;
  slug: string;
  description: string | null;
  kind: "one_on_one" | "group" | "collective" | "round_robin";
  duration: number;
  durationOptions: number[];
  color: string;
  locations: { type: string; value?: string }[];
  scheduleId: string | null;
  slotInterval: number | null;
  minNoticeMinutes: number;
  bookingWindowDays: number;
  bufferBefore: number;
  bufferAfter: number;
  maxPerDay: number | null;
  maxPerWeek: number | null;
  seats: number;
  requiresConfirmation: boolean;
  isPrivate: boolean;
  isActive: boolean;
  questions: { id: string; label: string; type: string; required: boolean; options?: string[] }[];
  redirectUrl: string | null;
  confirmationMessage: string | null;
  brandColor: string | null;
  hostUserIds: string[];
  team?: { id: string; name: string; slug: string } | null;
}

export interface ScheduleDto {
  id: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  weekly: { weekday: number; intervals: { start: number; end: number }[] }[];
  overrides: { date: string; kind: "available" | "unavailable"; intervals: { start: number; end: number }[]; label: string | null }[];
}
