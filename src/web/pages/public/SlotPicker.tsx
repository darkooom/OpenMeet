import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Globe } from "lucide-react";
import { Spinner, cn } from "@/components/ui";
import { addDays, toZonedParts, zonedToUtc, weekdayOf } from "../../../shared/time";
import { TIME_ZONES, fmtTime, intlLocale } from "../../lib/format";

export interface SlotsResponse {
  timezone: string;
  slots: { start: number; end: number }[];
}

interface Props {
  /** cache key for react-query */
  queryKey: unknown[];
  fetchSlots: (from: number, to: number) => Promise<SlotsResponse>;
  timezone: string;
  onTimezoneChange: (tz: string) => void;
  onPick: (start: number) => void;
  lang: string;
  accent?: string | null;
}

const WEEKDAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}
function addMonths(first: string, n: number) {
  const [y, m] = first.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
function daysInMonth(first: string) {
  const [y, m] = first.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function SlotPicker({ queryKey, fetchSlots, timezone, onTimezoneChange, onPick, lang, accent }: Props) {
  const today = toZonedParts(Date.now(), timezone).date;
  const [month, setMonth] = useState(monthStart(today));
  const [selected, setSelected] = useState<string | null>(null);
  const [h12, setH12] = useState(() => !lang.startsWith("de") && /en-US/.test(navigator.language));

  const from = Math.max(Date.now(), zonedToUtc(month, 0, timezone));
  const to = zonedToUtc(addMonths(month, 1), 0, timezone);
  const q = useQuery({ queryKey: [...queryKey, month, timezone], queryFn: () => fetchSlots(from, to), enabled: to > Date.now() });

  const byDay = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const s of q.data?.slots ?? []) {
      const d = toZonedParts(s.start, timezone).date;
      map.set(d, [...(map.get(d) ?? []), s.start]);
    }
    return map;
  }, [q.data, timezone]);

  // Jump to the first day with availability when the month loads.
  useEffect(() => {
    if (!q.data) return;
    if (selected && selected.startsWith(month.slice(0, 7)) && byDay.has(selected)) return;
    const first = [...byDay.keys()].sort()[0];
    setSelected(first ?? null);
  }, [q.data, byDay, month, selected]);

  const firstWeekday = (weekdayOf(month) + 6) % 7; // Monday-based grid
  const cells: (string | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth(month) }, (_, i) => addDays(month, i))];
  const monthLabel = new Intl.DateTimeFormat(intlLocale(lang), { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.parse(`${month}T12:00:00Z`));
  const canGoBack = month > monthStart(today);
  const slots = selected ? (byDay.get(selected) ?? []) : [];
  const selParts = selected ? Date.parse(`${selected}T12:00:00Z`) : null;
  const accentStyle = accent ? ({ "--color-accent": accent } as React.CSSProperties) : undefined;

  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_220px]" style={accentStyle}>
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold capitalize font-sans tracking-normal">{monthLabel}</h2>
          <div className="flex gap-1">
            <button type="button" disabled={!canGoBack} onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month" className="grid size-8 place-items-center rounded-full text-muted hover:bg-raised disabled:opacity-30">
              <ChevronLeft className="size-4" />
            </button>
            <button type="button" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month" className="grid size-8 place-items-center rounded-full text-muted hover:bg-raised">
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label={monthLabel}>
          {(lang === "de" ? WEEKDAYS_DE : WEEKDAYS_EN).map((d) => (
            <div key={d} className="pb-2 text-[12px] text-faint" role="columnheader">
              {d}
            </div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={`e${i}`} />;
            const available = byDay.has(d);
            const isSel = d === selected;
            return (
              <button
                key={d}
                type="button"
                role="gridcell"
                disabled={!available}
                aria-selected={isSel}
                aria-label={`${d}${available ? `, ${byDay.get(d)!.length} times available` : ", no times"}`}
                onClick={() => setSelected(d)}
                className={cn(
                  "relative mx-auto grid aspect-square w-full max-w-[46px] place-items-center rounded-full text-[14px] tabular transition-colors",
                  available ? "bg-accent-soft font-semibold text-accent hover:bg-accent hover:text-accent-ink" : "text-faint",
                  isSel && "!bg-accent !text-accent-ink",
                  d === today && !isSel && "ring-1 ring-line-strong",
                )}
              >
                {Number(d.slice(8))}
              </button>
            );
          })}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <Globe className="size-4" aria-hidden />
          <label htmlFor="tz" className="sr-only">
            Time zone
          </label>
          <select id="tz" value={timezone} onChange={(e) => onTimezoneChange(e.target.value)} className="max-w-[240px] bg-transparent py-1 text-ink focus:outline-none">
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <span className="mx-1 text-line-strong">|</span>
          <button type="button" onClick={() => setH12(!h12)} className="hover:text-ink" aria-pressed={h12}>
            {h12 ? "12 h" : "24 h"}
          </button>
        </div>
      </div>

      <div className="md:border-l md:border-line md:pl-6">
        {selParts && (
          <div className="mb-4 flex items-baseline gap-2" aria-live="polite">
            <span className="font-display text-[44px] font-semibold leading-none tracking-tight tabular">{new Date(selParts).getUTCDate()}</span>
            <span className="text-[13px] leading-tight text-muted">
              {new Intl.DateTimeFormat(intlLocale(lang), { weekday: "long", timeZone: "UTC" }).format(selParts)}
              <br />
              {new Intl.DateTimeFormat(intlLocale(lang), { month: "long", year: "numeric", timeZone: "UTC" }).format(selParts)}
            </span>
          </div>
        )}
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <p className="text-danger text-[13px]">Times could not be loaded. Please reload the page.</p>
        ) : slots.length === 0 ? (
          <p className="text-[13px] text-muted">{byDay.size === 0 ? "No free times this month. Try the next month." : "Pick a highlighted day."}</p>
        ) : (
          <ul className="flex max-h-[380px] flex-col gap-2 overflow-y-auto pr-1">
            {slots.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => onPick(s)}
                  className="h-11 w-full rounded-[var(--radius-control)] border border-accent/40 text-[14px] font-semibold text-accent tabular transition-colors hover:border-accent hover:bg-accent hover:text-accent-ink"
                >
                  {fmtTime(s, timezone, lang, h12)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
