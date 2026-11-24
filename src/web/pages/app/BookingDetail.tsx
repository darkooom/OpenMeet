import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";
import { Button, Dialog, ErrorNote, Field, Panel, Spinner, Textarea } from "@/components/ui";
import { errorMessage, get, post } from "../../lib/api";
import { LOCATION_LABELS, fmtDate, fmtRange } from "../../lib/format";
import { useUser } from "../../lib/session";
import type { BookingDetails } from "../../lib/types";
import { StatusBadge } from "./BookingRow";
import { SlotPicker, type SlotsResponse } from "../public/SlotPicker";

export default function BookingDetail() {
  const { id = "" } = useParams();
  const user = useUser();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["booking", id], queryFn: () => get<{ booking: BookingDetails }>(`/api/bookings/${id}`) });
  const [dialog, setDialog] = useState<null | "cancel" | "reject" | "reschedule">(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tz, setTz] = useState(user.timezone);

  if (q.isLoading) return <Spinner />;
  if (!q.data) return <ErrorNote>{errorMessage(q.error)}</ErrorNote>;
  const b = q.data.booking;
  const active = b.status === "confirmed" || b.status === "pending";
  const started = b.startAt <= Date.now();

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/bookings/${id}/${path}`, body);
      setDialog(null);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["booking", id] });
      void qc.invalidateQueries({ queryKey: ["bookings"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Link to="/app/bookings" className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Bookings
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] leading-tight">{b.eventType.title}</h1>
          <p className="mt-1 text-muted">
            {fmtDate(b.startAt, user.timezone)}, {fmtRange(b.startAt, b.endAt, user.timezone)}
          </p>
          <div className="mt-2">
            <StatusBadge status={b.status} noShow={b.noShow} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {b.status === "pending" && (
            <>
              <Button variant="primary" loading={busy} onClick={() => act("confirm")}>
                Confirm
              </Button>
              <Button variant="danger" onClick={() => setDialog("reject")}>
                Decline
              </Button>
            </>
          )}
          {active && !started && b.eventType.kind !== "group" && <Button onClick={() => setDialog("reschedule")}>Reschedule</Button>}
          {active && !started && (
            <Button variant="danger" onClick={() => setDialog("cancel")}>
              Cancel
            </Button>
          )}
          {active && started && (
            <Button onClick={() => act("no-show", { noShow: !b.noShow })} loading={busy}>
              {b.noShow ? "Undo no-show" : "Mark as no-show"}
            </Button>
          )}
          <a href={`/api/bookings/${id}/ics`} download>
            <Button>
              <Download className="size-4" /> .ics
            </Button>
          </a>
        </div>
      </div>
      <ErrorNote>{!dialog && error}</ErrorNote>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Details">
          <dl className="grid grid-cols-[120px_1fr] gap-y-3 px-5 py-4 text-[14px]">
            <dt className="text-muted">Hosts</dt>
            <dd>{b.hosts.map((h) => h.name).join(", ")}</dd>
            <dt className="text-muted">Location</dt>
            <dd className="break-all">
              {b.meetingUrl ? (
                <a href={b.meetingUrl} className="text-accent" target="_blank" rel="noreferrer">
                  {b.meetingUrl}
                </a>
              ) : (
                [b.locationType ? LOCATION_LABELS[b.locationType] : "Not specified", b.locationValue].filter(Boolean).join(": ")
              )}
            </dd>
            <dt className="text-muted">Booked</dt>
            <dd>{new Date(b.createdAt).toLocaleString()}</dd>
            {b.source && (
              <>
                <dt className="text-muted">Source</dt>
                <dd>{b.source}</dd>
              </>
            )}
            {b.utm && (
              <>
                <dt className="text-muted">Campaign</dt>
                <dd className="text-[13px]">{Object.entries(b.utm).map(([k, v]) => `${k}=${v}`).join(", ")}</dd>
              </>
            )}
            {b.cancelReason && (
              <>
                <dt className="text-muted">Reason</dt>
                <dd>{b.cancelReason}</dd>
              </>
            )}
          </dl>
        </Panel>
        <Panel title={b.attendees.length > 1 ? `Attendees (${b.attendees.filter((a) => a.status === "active").length})` : "Attendee"}>
          <ul className="divide-y divide-line">
            {b.attendees.map((a) => (
              <li key={a.id} className="px-5 py-4">
                <p className="font-medium">
                  {a.name} {a.status === "cancelled" && <span className="text-[12px] font-normal text-danger">cancelled</span>}
                </p>
                <a href={`mailto:${a.email}`} className="text-[13px] text-accent">
                  {a.email}
                </a>
                <p className="text-[12.5px] text-faint">Time zone: {a.timezone}</p>
                {Object.keys(a.answers).length > 0 && (
                  <dl className="mt-3 flex flex-col gap-2 text-[13px]">
                    {Object.entries(a.answers).map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-muted">{k}</dt>
                        <dd className="whitespace-pre-line">{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Dialog
        open={dialog === "cancel" || dialog === "reject"}
        onClose={() => setDialog(null)}
        title={dialog === "reject" ? "Decline this request?" : "Cancel this booking?"}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Keep booking</Button>
            <Button variant="danger" loading={busy} onClick={() => act(dialog === "reject" ? "reject" : "cancel", { reason: reason || null })}>
              {dialog === "reject" ? "Decline" : "Cancel booking"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <ErrorNote>{error}</ErrorNote>
          <p className="text-muted">The attendee is notified by e-mail{b.hosts.length > 0 ? " and the calendar event is removed" : ""}.</p>
          <Field label="Message to the attendee (optional)" htmlFor="reason">
            <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog open={dialog === "reschedule"} onClose={() => setDialog(null)} title="Pick a new time" wide>
        <ErrorNote>{error}</ErrorNote>
        <SlotPicker
          queryKey={["dash-reslots", id]}
          fetchSlots={(from, to) => get<SlotsResponse>(`/api/bookings/${id}/slots?from=${from}&to=${to}`)}
          timezone={tz}
          onTimezoneChange={setTz}
          onPick={(start) => act("reschedule", { start })}
          lang={user.locale}
        />
      </Dialog>
    </div>
  );
}
