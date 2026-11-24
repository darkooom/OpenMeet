import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, PageHeader, Spinner, cn } from "@/components/ui";
import { get } from "../../lib/api";
import { fmtTime } from "../../lib/format";
import { useUser } from "../../lib/session";
import type { BookingDetails } from "../../lib/types";
import { addDays, toZonedParts, weekKey, zonedToUtc } from "../../../shared/time";

const HOUR_PX = 48;
const START_HOUR = 7;
const END_HOUR = 21;

export default function CalendarView() {
  const user = useUser();
  const tz = user.timezone;
  const [week, setWeek] = useState(() => weekKey(toZonedParts(Date.now(), tz).date));
  const from = zonedToUtc(week, 0, tz);
  const to = zonedToUtc(addDays(week, 7), 0, tz);
  const q = useQuery({ queryKey: ["calendar", week], queryFn: () => get<{ bookings: BookingDetails[] }>(`/api/bookings?status=all&from=${from}&to=${to}&limit=200`) });
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const today = toZonedParts(Date.now(), tz).date;

  const byDay = useMemo(() => {
    const m = new Map<string, BookingDetails[]>();
    for (const b of q.data?.bookings ?? []) {
      if (b.status === "cancelled" || b.status === "rejected") continue;
      const d = toZonedParts(b.startAt, tz).date;
      m.set(d, [...(m.get(d) ?? []), b]);
    }
    return m;
  }, [q.data, tz]);

  const label = `${new Date(Date.parse(`${week}T12:00:00Z`)).toLocaleDateString(undefined, { day: "numeric", month: "long", timeZone: "UTC" })} – ${new Date(Date.parse(`${addDays(week, 6)}T12:00:00Z`)).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`;

  return (
    <div>
      <PageHeader
        title="Calendar"
        description={`Your booked meetings, shown in ${tz.replace(/_/g, " ")}.`}
        actions={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button size="sm" onClick={() => setWeek(weekKey(today))}>
              This week
            </Button>
            <Button size="sm" variant="ghost" aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        }
      />
      <p className="mb-3 text-[13px] font-medium text-muted">{label}</p>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface">
          <div className="grid min-w-[760px] grid-cols-[52px_repeat(7,1fr)]">
            <div className="border-b border-line" />
            {days.map((d) => (
              <div key={d} className={cn("border-b border-l border-line px-2 py-2 text-center", d === today && "bg-accent-soft")}>
                <p className="text-[12px] text-muted">{new Date(Date.parse(`${d}T12:00:00Z`)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}</p>
                <p className={cn("font-display text-[18px] font-semibold tabular", d === today && "text-accent")}>{Number(d.slice(8))}</p>
              </div>
            ))}
            <div className="relative" style={{ height: (END_HOUR - START_HOUR) * HOUR_PX }}>
              {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
                <span key={i} className="absolute right-2 -translate-y-2 text-[11px] text-faint tabular" style={{ top: i * HOUR_PX }}>
                  {String(START_HOUR + i).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            {days.map((d) => (
              <div key={d} className="relative border-l border-line" style={{ height: (END_HOUR - START_HOUR) * HOUR_PX }}>
                {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
                  <div key={i} className="absolute inset-x-0 border-t border-line/60" style={{ top: i * HOUR_PX }} />
                ))}
                {(byDay.get(d) ?? []).map((b) => {
                  const p = toZonedParts(b.startAt, tz);
                  const top = Math.max(0, (p.minuteOfDay / 60 - START_HOUR) * HOUR_PX);
                  const height = Math.max(22, ((b.endAt - b.startAt) / 3_600_000) * HOUR_PX - 2);
                  return (
                    <Link
                      key={b.id}
                      to={`/app/bookings/${b.id}`}
                      className={cn("absolute inset-x-1 overflow-hidden rounded-md border-l-[3px] bg-raised px-1.5 py-1 text-[11.5px] leading-tight hover:brightness-95", b.status === "pending" && "opacity-70")}
                      style={{ top, height, borderLeftColor: b.eventType.color }}
                      title={`${b.eventType.title} – ${b.attendees.map((a) => a.name).join(", ")}`}
                    >
                      <span className="block font-medium tabular">{fmtTime(b.startAt, tz)}</span>
                      <span className="block truncate">{b.attendees.map((a) => a.name).join(", ")}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
