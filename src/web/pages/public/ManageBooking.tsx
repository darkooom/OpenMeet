import { useState } from "react";
import { useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarX2, Check } from "lucide-react";
import { Button, ErrorNote, Field, Spinner, Textarea } from "@/components/ui";
import { errorMessage, get, post } from "../../lib/api";
import { LOCATION_LABELS, browserLocale, browserTimeZone, fmtDate, fmtRange } from "../../lib/format";
import { PublicFrame, useEmbed, type PublicEventType } from "./BookingPage";
import { SlotPicker, type SlotsResponse } from "./SlotPicker";

interface ManageView {
  id: string;
  status: string;
  startAt: number;
  endAt: number;
  meetingUrl: string | null;
  locationType: string | null;
  locationValue: string | null;
  cancelReason: string | null;
  attendee: { name: string; email: string; timezone: string };
  hosts: { name: string }[];
  eventType: PublicEventType;
}

export default function ManageBooking({ mode }: { mode: "view" | "reschedule" | "cancel" }) {
  const { token = "" } = useParams();
  const embed = useEmbed();
  const qc = useQueryClient();
  const lang = browserLocale();
  const [timezone, setTimezone] = useState(browserTimeZone());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<null | "cancelled" | "rescheduled">(null);
  const [pending, setPending] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["manage", token], queryFn: () => get<{ booking: ManageView }>(`/api/public/bookings/${token}`), retry: false });
  const b = q.data?.booking;

  if (q.isLoading) {
    return (
      <PublicFrame embed={embed}>
        <div className="grid min-h-[40vh] place-items-center">
          <Spinner />
        </div>
      </PublicFrame>
    );
  }
  if (!b) {
    return (
      <PublicFrame embed={embed}>
        <div className="mx-auto max-w-md py-20">
          <h1 className="text-2xl">Booking not found</h1>
          <p className="mt-2 text-muted">The link may be incomplete. Use the link from your confirmation e-mail.</p>
        </div>
      </PublicFrame>
    );
  }

  const cancelled = b.status === "cancelled" || b.status === "rejected";
  const past = b.endAt < Date.now();

  const doCancel = async () => {
    setLoading(true);
    setError(null);
    try {
      await post(`/api/public/bookings/${token}/cancel`, { reason: reason || null });
      setDone("cancelled");
      void qc.invalidateQueries({ queryKey: ["manage", token] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  const doReschedule = async () => {
    if (!pending) return;
    setLoading(true);
    setError(null);
    try {
      await post(`/api/public/bookings/${token}/reschedule`, { start: pending, reason: reason || null });
      setDone("rescheduled");
      void qc.invalidateQueries({ queryKey: ["manage", token] });
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    } finally {
      setLoading(false);
    }
  };

  const summary = (
    <dl className="grid grid-cols-[88px_1fr] gap-y-3 border-y border-line py-5 text-[14px]">
      <dt className="text-muted">What</dt>
      <dd>{b.eventType.title}</dd>
      <dt className="text-muted">When</dt>
      <dd className={cancelled ? "line-through text-muted" : ""}>
        {fmtDate(b.startAt, timezone, lang)}, {fmtRange(b.startAt, b.endAt, timezone, lang)}
      </dd>
      <dt className="text-muted">With</dt>
      <dd>{b.hosts.map((h) => h.name).join(", ")}</dd>
      {(b.meetingUrl || b.locationType) && !cancelled && (
        <>
          <dt className="text-muted">Where</dt>
          <dd className="break-all">{b.meetingUrl ? <a className="text-accent" href={b.meetingUrl}>{b.meetingUrl}</a> : (b.locationValue ?? LOCATION_LABELS[b.locationType!])}</dd>
        </>
      )}
    </dl>
  );

  return (
    <PublicFrame embed={embed}>
      <div className="mx-auto max-w-[760px] rounded-[16px] border border-line bg-surface p-6 md:p-10">
        {done === "cancelled" || (cancelled && mode !== "reschedule") ? (
          <div className="max-w-[480px]">
            <CalendarX2 className="size-8 text-muted" />
            <h1 className="mt-3 text-[26px]">Booking cancelled</h1>
            <p className="mt-2 mb-6 text-muted">{done ? "The organizer has been notified." : "This booking is no longer active."}</p>
            {summary}
          </div>
        ) : done === "rescheduled" ? (
          <div className="max-w-[480px]">
            <span className="grid size-10 place-items-center rounded-full bg-accent text-accent-ink">
              <Check className="size-5" />
            </span>
            <h1 className="mt-3 text-[26px]">Moved to the new time</h1>
            <p className="mt-2 mb-6 text-muted">An updated invite is on its way.</p>
            {summary}
          </div>
        ) : mode === "cancel" ? (
          <div className="max-w-[480px]">
            <h1 className="text-[26px]">Cancel this booking?</h1>
            <p className="mt-2 mb-6 text-muted">{b.attendee.name}, the organizer will be notified.</p>
            {summary}
            <div className="mt-6 flex flex-col gap-4">
              <ErrorNote>{error}</ErrorNote>
              <Field label="Reason (optional)" htmlFor="reason">
                <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
              </Field>
              <div className="flex gap-2">
                <Button variant="danger" loading={loading} onClick={doCancel} disabled={past}>
                  Cancel booking
                </Button>
                {b.eventType.kind !== "group" && !past && (
                  <a href={`/reschedule/${token}`} className="inline-flex h-9 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium text-muted hover:text-ink">
                    Reschedule instead
                  </a>
                )}
              </div>
            </div>
          </div>
        ) : mode === "reschedule" && !cancelled && !past && b.eventType.kind !== "group" ? (
          <div>
            <h1 className="text-[26px]">Pick a new time</h1>
            <p className="mt-2 mb-6 text-muted">
              Currently: {fmtDate(b.startAt, timezone, lang)}, {fmtRange(b.startAt, b.endAt, timezone, lang)}
            </p>
            <ErrorNote>{error}</ErrorNote>
            {pending ? (
              <div className="flex max-w-[480px] flex-col gap-4">
                <p className="rounded-[var(--radius-control)] bg-accent-soft px-3 py-2 font-medium text-accent">
                  New time: {fmtDate(pending, timezone, lang)}, {fmtRange(pending, pending + (b.endAt - b.startAt), timezone, lang)}
                </p>
                <Field label="Message to the organizer (optional)" htmlFor="r-reason">
                  <Textarea id="r-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
                </Field>
                <div className="flex gap-2">
                  <Button variant="primary" loading={loading} onClick={doReschedule}>
                    Confirm new time
                  </Button>
                  <Button variant="ghost" onClick={() => setPending(null)}>
                    Choose another time
                  </Button>
                </div>
              </div>
            ) : (
              <SlotPicker
                queryKey={["reslots", token]}
                fetchSlots={(from, to) => get<SlotsResponse>(`/api/public/bookings/${token}/slots?from=${from}&to=${to}`)}
                timezone={timezone}
                onTimezoneChange={setTimezone}
                onPick={setPending}
                lang={lang}
              />
            )}
          </div>
        ) : (
          <div className="max-w-[480px]">
            <h1 className="text-[26px]">{cancelled ? "Booking cancelled" : past ? "This meeting has ended" : "Your booking"}</h1>
            <p className="mt-2 mb-6 text-muted">{b.eventType.kind === "group" && mode === "reschedule" ? "Group sessions cannot be moved. Cancel and book another session instead." : `Booked by ${b.attendee.name}.`}</p>
            {summary}
            {!cancelled && !past && (
              <div className="mt-6 flex gap-2">
                {b.eventType.kind !== "group" && (
                  <a href={`/reschedule/${token}`} className="inline-flex h-9 items-center rounded-[var(--radius-control)] border border-line-strong px-3 text-sm font-medium">
                    Reschedule
                  </a>
                )}
                <a href={`/cancel/${token}`} className="inline-flex h-9 items-center rounded-[var(--radius-control)] px-3 text-sm font-medium text-danger">
                  Cancel
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </PublicFrame>
  );
}
