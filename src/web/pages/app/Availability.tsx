import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Star, Trash2 } from "lucide-react";
import { Badge, Button, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner, cn } from "@/components/ui";
import { del, errorMessage, get, post, put } from "../../lib/api";
import { TIME_ZONES, browserTimeZone } from "../../lib/format";
import type { ScheduleDto } from "../../lib/types";
import { hhmmToMinutes, minutesToHHMM } from "../../../shared/time";

const DAYS = [
  { wd: 1, label: "Monday" },
  { wd: 2, label: "Tuesday" },
  { wd: 3, label: "Wednesday" },
  { wd: 4, label: "Thursday" },
  { wd: 5, label: "Friday" },
  { wd: 6, label: "Saturday" },
  { wd: 0, label: "Sunday" },
];

type Interval = { start: number; end: number };

function toInput(min: number) {
  return min >= 1440 ? "24:00" : minutesToHHMM(min);
}

function IntervalEditor({ intervals, onChange }: { intervals: Interval[]; onChange: (v: Interval[]) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {intervals.map((iv, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            type="time"
            aria-label="From"
            className="w-[104px] sm:w-[118px] tabular"
            value={toInput(iv.start)}
            onChange={(e) => {
              const next = [...intervals];
              next[i] = { ...iv, start: hhmmToMinutes(e.target.value || "00:00") };
              onChange(next);
            }}
          />
          <span className="text-faint">–</span>
          <Input
            type="time"
            aria-label="To"
            className="w-[104px] sm:w-[118px] tabular"
            value={toInput(iv.end)}
            onChange={(e) => {
              const next = [...intervals];
              const v = e.target.value === "00:00" ? 1440 : hhmmToMinutes(e.target.value || "00:00");
              next[i] = { ...iv, end: v };
              onChange(next);
            }}
          />
          <button type="button" aria-label="Remove time range" onClick={() => onChange(intervals.filter((_, j) => j !== i))} className="rounded p-1.5 text-faint hover:text-danger">
            <Trash2 className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

function ScheduleEditor({ schedule, onSaved }: { schedule: ScheduleDto; onSaved: () => void }) {
  const [s, setS] = useState(schedule);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newDate, setNewDate] = useState("");
  useEffect(() => setS(schedule), [schedule]);

  const day = (wd: number) => s.weekly.find((w) => w.weekday === wd)?.intervals ?? [];
  const setDay = (wd: number, intervals: Interval[]) => setS({ ...s, weekly: [...s.weekly.filter((w) => w.weekday !== wd), { weekday: wd, intervals }] });
  const invalid = s.weekly.some((w) => w.intervals.some((i) => i.end <= i.start)) || s.overrides.some((o) => o.intervals.some((i) => i.end <= i.start));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await put(`/api/schedules/${s.id}`, { name: s.name, timezone: s.timezone, isDefault: s.isDefault, weekly: s.weekly, overrides: s.overrides });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <ErrorNote>{error}</ErrorNote>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="s-name">
          <Input id="s-name" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
        </Field>
        <Field label="Time zone" htmlFor="s-tz">
          <Select id="s-tz" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
            {TIME_ZONES.map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </Select>
        </Field>
      </div>

      <Panel title="Weekly hours">
        <ul className="divide-y divide-line">
          {DAYS.map(({ wd, label }) => {
            const iv = day(wd);
            return (
              <li key={wd} className="grid grid-cols-[110px_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
                <label className="flex items-center gap-2 pt-2 text-sm font-medium">
                  <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={iv.length > 0} onChange={(e) => setDay(wd, e.target.checked ? [{ start: 540, end: 1020 }] : [])} />
                  {label}
                </label>
                {iv.length > 0 ? <IntervalEditor intervals={iv} onChange={(v) => setDay(wd, v)} /> : <p className="pt-2 text-[13px] text-faint">Unavailable</p>}
                <div className="flex gap-1 pt-1">
                  <button type="button" aria-label={`Add time range on ${label}`} title="Add time range" onClick={() => setDay(wd, [...iv, iv.length ? { start: Math.min(iv[iv.length - 1]!.end + 60, 1380), end: Math.min(iv[iv.length - 1]!.end + 120, 1440) } : { start: 540, end: 1020 }])} className="rounded p-1.5 text-muted hover:bg-raised hover:text-ink">
                    <Plus className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Copy ${label} to all weekdays`}
                    title="Copy to Monday–Friday"
                    onClick={() => setS({ ...s, weekly: [...s.weekly.filter((w) => ![1, 2, 3, 4, 5].includes(w.weekday)), ...[1, 2, 3, 4, 5].map((d) => ({ weekday: d, intervals: iv.map((x) => ({ ...x })) }))] })}
                    className="rounded p-1.5 text-muted hover:bg-raised hover:text-ink"
                  >
                    <Copy className="size-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel title="Date overrides" actions={<span className="text-[12.5px] text-muted">Holidays, vacation and special hours</span>}>
        <div className="flex flex-col gap-3 px-5 py-4">
          {s.overrides.length === 0 && <p className="text-[13px] text-muted">No overrides. Add a date to block it or to set different hours.</p>}
          {[...s.overrides]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((o) => (
              <div key={o.date} className="grid gap-3 rounded-[var(--radius-control)] border border-line p-3 sm:grid-cols-[130px_150px_1fr_auto]">
                <p className="pt-2 font-medium tabular">{o.date}</p>
                <Select
                  aria-label="Override type"
                  value={o.kind === "unavailable" && o.intervals.length === 0 ? "off" : o.kind === "unavailable" ? "block" : "hours"}
                  onChange={(e) => {
                    const v = e.target.value;
                    const next = s.overrides.map((x) => (x.date === o.date ? { ...x, kind: v === "hours" ? ("available" as const) : ("unavailable" as const), intervals: v === "off" ? [] : x.intervals.length ? x.intervals : [{ start: 540, end: 720 }] } : x));
                    setS({ ...s, overrides: next });
                  }}
                >
                  <option value="off">Whole day off</option>
                  <option value="hours">Different hours</option>
                  <option value="block">Block time range</option>
                </Select>
                <div>
                  {o.intervals.length > 0 && <IntervalEditor intervals={o.intervals} onChange={(v) => setS({ ...s, overrides: s.overrides.map((x) => (x.date === o.date ? { ...x, intervals: v } : x)) })} />}
                  <Input className="mt-2" aria-label="Label" placeholder="Label, e.g. Public holiday" value={o.label ?? ""} onChange={(e) => setS({ ...s, overrides: s.overrides.map((x) => (x.date === o.date ? { ...x, label: e.target.value } : x)) })} />
                </div>
                <button type="button" aria-label="Remove override" onClick={() => setS({ ...s, overrides: s.overrides.filter((x) => x.date !== o.date) })} className="self-start rounded p-1.5 text-faint hover:text-danger">
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          <div className="flex items-end gap-2">
            <Field label="Add date" htmlFor="ov-date">
              <Input id="ov-date" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
            </Field>
            <Button
              disabled={!newDate || s.overrides.some((o) => o.date === newDate)}
              onClick={() => {
                setS({ ...s, overrides: [...s.overrides, { date: newDate, kind: "unavailable", intervals: [], label: null }] });
                setNewDate("");
              }}
            >
              <Plus className="size-4" /> Add
            </Button>
          </div>
        </div>
      </Panel>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} loading={saving} disabled={invalid}>
          {saved ? "Saved" : "Save availability"}
        </Button>
        {invalid && <p className="text-[13px] text-danger">Every time range must end after it starts.</p>}
      </div>
    </div>
  );
}

export default function Availability() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["schedules"], queryFn: () => get<{ schedules: ScheduleDto[] }>("/api/schedules") });
  const [selected, setSelected] = useState<string | null>(null);
  const schedules = q.data?.schedules ?? [];
  const current = schedules.find((s) => s.id === selected) ?? schedules.find((s) => s.isDefault) ?? schedules[0];

  const create = async () => {
    const res = await post<{ schedule: ScheduleDto }>("/api/schedules", {
      name: "New schedule",
      timezone: browserTimeZone(),
      weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, intervals: [{ start: 540, end: 1020 }] })),
      overrides: [],
    });
    await qc.invalidateQueries({ queryKey: ["schedules"] });
    setSelected(res.schedule.id);
  };
  const makeDefault = async (s: ScheduleDto) => {
    await put(`/api/schedules/${s.id}`, { ...s, isDefault: true });
    void qc.invalidateQueries({ queryKey: ["schedules"] });
  };
  const remove = async (s: ScheduleDto) => {
    if (!confirm(`Delete "${s.name}"?`)) return;
    await del(`/api/schedules/${s.id}`);
    setSelected(null);
    void qc.invalidateQueries({ queryKey: ["schedules"] });
  };

  return (
    <div>
      <PageHeader
        title="Availability"
        description="When you can be booked. Changes apply to new bookings immediately."
        actions={
          <Button onClick={create}>
            <Plus className="size-4" /> New schedule
          </Button>
        }
      />
      {q.isLoading || !current ? (
        <Spinner />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Schedules" className="flex flex-row flex-wrap gap-1 xl:flex-col">
            {schedules.map((s) => (
              <div key={s.id} className={cn("group flex items-center justify-between rounded-[var(--radius-control)] px-3 py-2 text-[13.5px]", s.id === current.id ? "bg-surface border border-line" : "hover:bg-raised")}>
                <button type="button" onClick={() => setSelected(s.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block truncate text-[12px] text-muted">{s.timezone}</span>
                </button>
                {s.isDefault ? (
                  <Badge tone="accent">Default</Badge>
                ) : (
                  <span className="flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                    <button type="button" aria-label="Make default" title="Make default" onClick={() => makeDefault(s)} className="rounded p-1 text-faint hover:text-ink">
                      <Star className="size-3.5" />
                    </button>
                    <button type="button" aria-label="Delete schedule" onClick={() => remove(s)} className="rounded p-1 text-faint hover:text-danger">
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </nav>
          <div className="min-w-0">
            <ScheduleEditor key={current.id} schedule={current} onSaved={() => void qc.invalidateQueries({ queryKey: ["schedules"] })} />
          </div>
        </div>
      )}
    </div>
  );
}
