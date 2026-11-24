import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarPlus, Check, Copy, Info, Plug } from "lucide-react";
import { Button, EmptyState, PageHeader, Panel, Spinner, cn } from "@/components/ui";
import { get } from "../../lib/api";
import { useUser } from "../../lib/session";
import type { BookingDetails } from "../../lib/types";
import { BookingRow } from "./BookingRow";

interface OverviewData {
  today: BookingDetails[];
  upcoming: BookingDetails[];
  recent: BookingDetails[];
  stats: { last30Days: number; confirmed30: number; cancelled30: number; pending: number; newLast7: number; cancelledLast7: number };
  bookingLink: string;
  integrations: { id: string; provider: string; accountEmail: string | null; status: string; lastError: string | null }[];
  notifications: { level: "info" | "warning" | "error"; message: string; href?: string }[];
  activity: { action: string; createdAt: number }[];
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? "Copied" : label}
    </Button>
  );
}

const ACTION_LABELS: Record<string, string> = {
  "booking.created": "New booking",
  "booking.cancelled": "Booking cancelled",
  "booking.cancelled_by_attendee": "Attendee cancelled",
  "booking.rescheduled": "Booking rescheduled",
  "booking.rescheduled_by_attendee": "Attendee rescheduled",
  "booking.confirmed": "Booking confirmed",
  "event_type.created": "Event type created",
  "event_type.updated": "Event type updated",
  "auth.login": "Signed in",
  "schedule.updated": "Availability changed",
  "integration.connected": "Integration connected",
};

export default function Overview() {
  const user = useUser();
  const q = useQuery({ queryKey: ["overview"], queryFn: () => get<OverviewData>("/api/insights/overview") });
  if (q.isLoading || !q.data) return <Spinner />;
  const d = q.data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const stats = [
    { label: "Today", value: d.today.length },
    { label: "New this week", value: d.stats.newLast7 },
    { label: "Awaiting confirmation", value: d.stats.pending },
    { label: "Cancelled this week", value: d.stats.cancelledLast7 },
  ];

  return (
    <div>
      <PageHeader
        title={`${greeting}, ${user.name.split(" ")[0]}`}
        description={d.stats.last30Days === 0 ? "No bookings in the last 30 days yet." : `${d.stats.last30Days} ${d.stats.last30Days === 1 ? "booking" : "bookings"} in the last 30 days, ${d.stats.cancelled30} cancelled.`}
        actions={
          <Link to="/app/event-types/new">
            <Button variant="primary">
              <CalendarPlus className="size-4" /> New event type
            </Button>
          </Link>
        }
      />

      {d.notifications.length > 0 && (
        <ul className="mb-6 flex flex-col gap-2">
          {d.notifications.map((n, i) => (
            <li key={i} className={cn("flex items-start gap-2.5 rounded-[var(--radius-control)] border px-3.5 py-2.5 text-[13.5px]", n.level === "error" ? "border-danger/30 bg-danger-soft text-danger" : n.level === "warning" ? "border-warn/30 bg-warn-soft text-warn" : "border-line bg-surface text-muted")}>
              {n.level === "info" ? <Info className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
              <span className="flex-1">{n.message}</span>
              {n.href && (
                <Link to={n.href} className="font-medium underline-offset-2 hover:underline">
                  Fix
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <dl className="mb-8 grid grid-cols-2 divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface sm:grid-cols-4 sm:divide-x">
        {stats.map((s) => (
          <div key={s.label} className="px-5 py-4">
            <dt className="text-[12.5px] text-muted">{s.label}</dt>
            <dd className="mt-1 font-display text-[28px] font-semibold leading-none tabular">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-6">
          <Panel title="Today">
            {d.today.length === 0 ? (
              <p className="px-5 py-6 text-muted">Nothing scheduled for today.</p>
            ) : (
              <ul className="divide-y divide-line">{d.today.map((b) => <BookingRow key={b.id} b={b} tz={user.timezone} compact />)}</ul>
            )}
          </Panel>
          <Panel
            title="Upcoming"
            actions={
              <Link to="/app/bookings" className="text-[13px] font-medium text-accent">
                All bookings
              </Link>
            }
          >
            {d.upcoming.length === 0 ? (
              <EmptyState title="No upcoming bookings" action={<CopyButton value={d.bookingLink} label="Copy booking link" />}>
                Share your booking link so people can pick a time.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">{d.upcoming.map((b) => <BookingRow key={b.id} b={b} tz={user.timezone} />)}</ul>
            )}
          </Panel>
          {d.recent.length > 0 && (
            <Panel title="Recently booked">
              <ul className="divide-y divide-line">{d.recent.map((b) => <BookingRow key={b.id} b={b} tz={user.timezone} compact />)}</ul>
            </Panel>
          )}
        </div>
        <div className="flex flex-col gap-6">
          <Panel title="Your booking page">
            <div className="flex flex-col gap-3 px-5 py-4">
              <a href={d.bookingLink} target="_blank" rel="noreferrer" className="break-all text-[13.5px] text-accent">
                {d.bookingLink.replace(/^https?:\/\//, "")}
              </a>
              <div className="flex gap-2">
                <CopyButton value={d.bookingLink} />
                <Link to="/app/availability">
                  <Button size="sm" variant="ghost">
                    Edit availability
                  </Button>
                </Link>
              </div>
            </div>
          </Panel>
          <Panel
            title="Integrations"
            actions={
              <Link to="/app/integrations" className="text-[13px] font-medium text-accent">
                Manage
              </Link>
            }
          >
            {d.integrations.length === 0 ? (
              <EmptyState icon={<Plug className="size-5" />} title="No calendar connected">
                Connect a calendar to avoid conflicts with existing appointments.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {d.integrations.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 px-5 py-3 text-[13.5px]">
                    <span className="truncate">
                      <span className="capitalize">{i.provider}</span> <span className="text-muted">{i.accountEmail}</span>
                    </span>
                    <span className={cn("size-2 shrink-0 rounded-full", i.status === "active" && !i.lastError ? "bg-accent" : "bg-danger")} title={i.lastError ?? i.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Activity">
            {d.activity.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-muted">No activity yet.</p>
            ) : (
              <ul className="flex flex-col gap-2.5 px-5 py-4 text-[13px]">
                {d.activity.map((a, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span>{ACTION_LABELS[a.action] ?? a.action}</span>
                    <time className="shrink-0 text-faint tabular">{new Date(a.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
