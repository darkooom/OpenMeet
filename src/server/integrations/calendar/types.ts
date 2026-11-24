import type { Interval } from "../../services/slots";

export interface ExternalCalendar {
  externalId: string;
  name: string;
  primary: boolean;
  writable: boolean;
}

export interface CalendarEventInput {
  title: string;
  description: string;
  start: number;
  end: number;
  timezone: string;
  location?: string | null;
  attendees: { name: string; email: string }[];
  /** Ask the provider to attach a native conference (Google Meet / Teams). */
  conference?: "google_meet" | "ms_teams" | null;
  uid: string;
}

export interface CreatedEvent {
  id: string;
  meetingUrl?: string | null;
}

export interface ConnectionContext {
  /** Returns a valid access token (refreshing it when needed). */
  accessToken(): Promise<string>;
  /** Decrypted provider specific credentials (ICS URL, CalDAV login ...). */
  credentials: Record<string, string> | null;
  fetch: typeof fetch;
}

/**
 * Adapter contract for calendar providers. Adding a provider means
 * implementing this interface and registering it in ./index.ts.
 */
export interface CalendarAdapter {
  readonly provider: "google" | "microsoft" | "ics" | "caldav";
  readonly canWrite: boolean;
  listCalendars(ctx: ConnectionContext): Promise<ExternalCalendar[]>;
  freeBusy(ctx: ConnectionContext, calendarIds: string[], from: number, to: number): Promise<Interval[]>;
  createEvent(ctx: ConnectionContext, calendarId: string, event: CalendarEventInput): Promise<CreatedEvent>;
  updateEvent(ctx: ConnectionContext, calendarId: string, eventId: string, event: CalendarEventInput): Promise<CreatedEvent>;
  deleteEvent(ctx: ConnectionContext, calendarId: string, eventId: string): Promise<void>;
}

export class ProviderHttpError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
  ) {
    super(`${provider} API error ${status}: ${message}`);
  }
}

export async function expectOk(provider: string, res: Response): Promise<Response> {
  if (!res.ok) {
    let detail = "";
    try {
      const text = await res.text();
      detail = text.slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new ProviderHttpError(provider, res.status, detail);
  }
  return res;
}
