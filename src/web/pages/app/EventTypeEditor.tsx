import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Link2, Plus, Trash2 } from "lucide-react";
import { Button, ErrorNote, Field, Input, Panel, Select, Spinner, Switch, Textarea } from "@/components/ui";
import { del, errorMessage, get, post, put } from "../../lib/api";
import { LOCATION_LABELS } from "../../lib/format";
import { useSession, useUser } from "../../lib/session";
import type { EventTypeDto, ScheduleDto } from "../../lib/types";
import { CopyButton } from "./Overview";

type Form = Omit<EventTypeDto, "id" | "ownerUserId" | "team"> & { teamId: string | null };

const DEFAULT: Form = {
  teamId: null,
  title: "",
  slug: "",
  description: "",
  kind: "one_on_one",
  duration: 30,
  durationOptions: [],
  color: "#1f7a5c",
  locations: [{ type: "jitsi" }],
  scheduleId: null,
  slotInterval: null,
  minNoticeMinutes: 120,
  bookingWindowDays: 60,
  bufferBefore: 0,
  bufferAfter: 0,
  maxPerDay: null,
  maxPerWeek: null,
  seats: 1,
  requiresConfirmation: false,
  isPrivate: false,
  isActive: true,
  questions: [],
  redirectUrl: null,
  confirmationMessage: null,
  brandColor: null,
  hostUserIds: [],
};

const COLORS = ["#1f7a5c", "#2f5bd3", "#7b4fd6", "#c2410c", "#be185d", "#0e7490", "#4d7c0f", "#57534e"];

function slugify(s: string) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Panel>
      <div className="grid gap-6 p-5 md:grid-cols-[220px_1fr] md:p-6">
        <div>
          <h2 className="font-sans text-[15px] font-semibold tracking-normal">{title}</h2>
          {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
        </div>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </Panel>
  );
}

const num = (v: string) => (v === "" ? null : Number(v));

export default function EventTypeEditor() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useUser();
  const { me } = useSession();
  const [form, setForm] = useState<Form>(DEFAULT);
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newLink, setNewLink] = useState<string | null>(null);

  const etQ = useQuery({ queryKey: ["event-type", id], queryFn: () => get<{ eventType: EventTypeDto }>(`/api/event-types/${id}`), enabled: !isNew });
  const schedulesQ = useQuery({ queryKey: ["schedules"], queryFn: () => get<{ schedules: ScheduleDto[] }>("/api/schedules") });
  const orgsQ = useQuery({ queryKey: ["orgs"], queryFn: () => get<{ organizations: { id: string; name: string; role: string }[] }>("/api/orgs") });
  const teamsQ = useQuery({
    queryKey: ["all-teams", orgsQ.data?.organizations.map((o) => o.id).join(",")],
    enabled: !!orgsQ.data,
    queryFn: async () => {
      const teams: { id: string; name: string; members: { userId: string }[]; orgId: string }[] = [];
      const memberNames: Record<string, string> = {};
      for (const o of orgsQ.data!.organizations) {
        const d = await get<{ teams: { id: string; name: string; members: { userId: string }[] }[]; members: { id: string; name: string }[] }>(`/api/orgs/${o.id}`);
        for (const t of d.teams) teams.push({ ...t, orgId: o.id });
        for (const m of d.members) memberNames[m.id] = m.name;
      }
      return { teams, memberNames };
    },
  });
  const linksQ = useQuery({ queryKey: ["links", id], queryFn: () => get<{ links: { id: string; singleUse: boolean; usedAt: number | null; expiresAt: number | null; createdAt: number }[] }>(`/api/event-types/${id}/links`), enabled: !isNew });

  useEffect(() => {
    if (etQ.data) {
      const { id: _i, ownerUserId: _o, team: _t, ...rest } = etQ.data.eventType;
      setForm({ ...DEFAULT, ...rest, description: rest.description ?? "" });
    }
  }, [etQ.data]);

  if (!isNew && etQ.isLoading) return <Spinner />;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const memberNames = teamsQ.data?.memberNames ?? {};
  const team = teamsQ.data?.teams.find((t) => t.id === form.teamId);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { ...form, redirectUrl: form.redirectUrl || "", description: form.description || null, confirmationMessage: form.confirmationMessage || null };
      if (isNew) {
        const res = await post<{ eventType: EventTypeDto }>("/api/event-types", body);
        void qc.invalidateQueries({ queryKey: ["event-types"] });
        navigate(`/app/event-types/${res.eventType.id}`, { replace: true });
      } else {
        await put(`/api/event-types/${id}`, body);
        void qc.invalidateQueries({ queryKey: ["event-types"] });
        void qc.invalidateQueries({ queryKey: ["event-type", id] });
      }
    } catch (err) {
      setError(errorMessage(err));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this event type? Event types with bookings are archived instead.")) return;
    await del(`/api/event-types/${id}`);
    void qc.invalidateQueries({ queryKey: ["event-types"] });
    navigate("/app/event-types");
  };

  const createLink = async () => {
    const res = await post<{ url: string }>(`/api/event-types/${id}/links`, { singleUse: true, expiresInDays: 30 });
    setNewLink(res.url);
    void linksQ.refetch();
  };

  const teamOptions = teamsQ.data?.teams ?? [];
  const isTeamKind = form.kind === "collective" || form.kind === "round_robin";

  return (
    <form onSubmit={save} className="flex flex-col gap-5 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => navigate("/app/event-types")} className="flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-4" /> Event types
        </button>
        <div className="flex gap-2">
          {!isNew && (
            <Button variant="danger" onClick={remove}>
              <Trash2 className="size-4" /> Delete
            </Button>
          )}
          <Button type="submit" variant="primary" loading={saving}>
            {isNew ? "Create event type" : "Save changes"}
          </Button>
        </div>
      </div>
      <h1 className="text-[26px]">{isNew ? "New event type" : form.title || "Event type"}</h1>
      <ErrorNote>{error}</ErrorNote>

      <Section title="Basics" description="What people see on your booking page.">
        <Field label="Title" htmlFor="title">
          <Input id="title" required value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value, slug: slugTouched ? f.slug : slugify(e.target.value) }))} placeholder="30 minute support call" />
        </Field>
        <Field label="URL" htmlFor="slug" hint={`${window.location.origin}/${team ? `team/…` : `u/${user.username}`}/${form.slug || "…"}`}>
          <Input
            id="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={form.slug}
            onChange={(e) => {
              setSlugTouched(true);
              set("slug", e.target.value.toLowerCase());
            }}
          />
        </Field>
        <Field label="Description" htmlFor="desc">
          <Textarea id="desc" value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder="What will you talk about? What should people prepare?" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Duration (minutes)" htmlFor="dur">
            <Input id="dur" type="number" min={5} max={720} required value={form.duration} onChange={(e) => set("duration", Number(e.target.value))} />
          </Field>
          <Field label="Other durations to offer" htmlFor="durs" hint="Comma separated, e.g. 15, 60">
            <Input
              id="durs"
              value={form.durationOptions.join(", ")}
              onChange={(e) =>
                set(
                  "durationOptions",
                  e.target.value
                    .split(",")
                    .map((x) => Number(x.trim()))
                    .filter((x) => Number.isInteger(x) && x >= 5 && x <= 720),
                )
              }
            />
          </Field>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-medium">Color</p>
          <div className="flex gap-2" role="radiogroup" aria-label="Color">
            {COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={form.color === c} aria-label={c} onClick={() => set("color", c)} className="size-7 rounded-full ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-ink" style={{ background: c }} />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Location" description="Offer one or more ways to meet. Generated meeting links require the matching integration.">
        {form.locations.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field label={i === 0 ? "Type" : ""} htmlFor={`loc-${i}`} className="min-w-[200px] flex-1">
              <Select
                id={`loc-${i}`}
                value={l.type}
                onChange={(e) => {
                  const next = [...form.locations];
                  next[i] = { type: e.target.value };
                  set("locations", next);
                }}
              >
                {Object.entries(LOCATION_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            {["custom_video", "phone", "in_person", "jitsi"].includes(l.type) && (
              <Field label={i === 0 ? (l.type === "jitsi" ? "Jitsi server (optional)" : "Details") : ""} htmlFor={`locv-${i}`} className="min-w-[220px] flex-1">
                <Input
                  id={`locv-${i}`}
                  required={l.type !== "jitsi"}
                  placeholder={l.type === "custom_video" ? "https://…" : l.type === "phone" ? "+49 …" : l.type === "jitsi" ? "https://meet.jit.si" : "Street, city"}
                  value={l.value ?? ""}
                  onChange={(e) => {
                    const next = [...form.locations];
                    next[i] = { ...l, value: e.target.value };
                    set("locations", next);
                  }}
                />
              </Field>
            )}
            <Button variant="ghost" aria-label="Remove location" onClick={() => set("locations", form.locations.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={() => set("locations", [...form.locations, { type: "custom_video" }])} disabled={form.locations.length >= 6}>
            <Plus className="size-3.5" /> Add location
          </Button>
        </div>
      </Section>

      <Section title="Booking type" description="Who hosts this meeting.">
        <Field label="Type" htmlFor="kind">
          <Select id="kind" value={form.kind} onChange={(e) => set("kind", e.target.value as Form["kind"])}>
            <option value="one_on_one">One-on-one</option>
            <option value="group">Group (several attendees per slot)</option>
            <option value="collective" disabled={teamOptions.length === 0}>Collective (all team hosts attend)</option>
            <option value="round_robin" disabled={teamOptions.length === 0}>Round robin (one available team host)</option>
          </Select>
        </Field>
        {form.kind === "group" && (
          <Field label="Seats per slot" htmlFor="seats">
            <Input id="seats" type="number" min={2} max={1000} value={form.seats} onChange={(e) => set("seats", Number(e.target.value))} />
          </Field>
        )}
        {(isTeamKind || form.teamId) && (
          <Field label="Team" htmlFor="team" hint={!isNew ? "The team cannot be changed after creation." : undefined}>
            <Select id="team" value={form.teamId ?? ""} disabled={!isNew} required={isTeamKind} onChange={(e) => set("teamId", e.target.value || null)}>
              <option value="">Personal</option>
              {teamOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {team && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-[13px] font-medium">Hosts (none selected = all team members)</legend>
            {team.members.map((m) => (
              <label key={m.userId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-accent)]"
                  checked={form.hostUserIds.includes(m.userId)}
                  onChange={(e) => set("hostUserIds", e.target.checked ? [...form.hostUserIds, m.userId] : form.hostUserIds.filter((x) => x !== m.userId))}
                />
                {memberNames[m.userId] ?? m.userId}
                {m.userId === me?.user?.id && <span className="text-faint">(you)</span>}
              </label>
            ))}
          </fieldset>
        )}
      </Section>

      <Section title="Availability & limits" description="When this event can be booked.">
        <Field label="Schedule" htmlFor="sched" hint="Team events always use each host's default schedule.">
          <Select id="sched" value={form.scheduleId ?? ""} onChange={(e) => set("scheduleId", e.target.value || null)} disabled={!!form.teamId}>
            <option value="">Default schedule</option>
            {schedulesQ.data?.schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.timezone})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Minimum notice (minutes)" htmlFor="notice">
            <Input id="notice" type="number" min={0} value={form.minNoticeMinutes} onChange={(e) => set("minNoticeMinutes", Number(e.target.value))} />
          </Field>
          <Field label="Bookable up to (days ahead)" htmlFor="window">
            <Input id="window" type="number" min={1} max={730} value={form.bookingWindowDays} onChange={(e) => set("bookingWindowDays", Number(e.target.value))} />
          </Field>
          <Field label="Buffer before (minutes)" htmlFor="bb">
            <Input id="bb" type="number" min={0} max={240} value={form.bufferBefore} onChange={(e) => set("bufferBefore", Number(e.target.value))} />
          </Field>
          <Field label="Buffer after (minutes)" htmlFor="ba">
            <Input id="ba" type="number" min={0} max={240} value={form.bufferAfter} onChange={(e) => set("bufferAfter", Number(e.target.value))} />
          </Field>
          <Field label="Start times every (minutes)" htmlFor="interval" hint="Empty = event duration">
            <Input id="interval" type="number" min={5} max={720} value={form.slotInterval ?? ""} onChange={(e) => set("slotInterval", num(e.target.value))} />
          </Field>
          <div />
          <Field label="Max. bookings per day" htmlFor="mpd">
            <Input id="mpd" type="number" min={1} value={form.maxPerDay ?? ""} onChange={(e) => set("maxPerDay", num(e.target.value))} placeholder="Unlimited" />
          </Field>
          <Field label="Max. bookings per week" htmlFor="mpw">
            <Input id="mpw" type="number" min={1} value={form.maxPerWeek ?? ""} onChange={(e) => set("maxPerWeek", num(e.target.value))} placeholder="Unlimited" />
          </Field>
        </div>
      </Section>

      <Section title="Booking questions" description="Name and e-mail are always asked.">
        {form.questions.map((qn, i) => (
          <div key={i} className="grid gap-2 rounded-[var(--radius-control)] border border-line p-3 sm:grid-cols-[1fr_150px_auto]">
            <Input
              aria-label="Question"
              placeholder="Question"
              required
              value={qn.label}
              onChange={(e) => {
                const next = [...form.questions];
                next[i] = { ...qn, label: e.target.value, id: qn.id || slugify(e.target.value).slice(0, 40) || `q${i}` };
                set("questions", next);
              }}
            />
            <Select
              aria-label="Answer type"
              value={qn.type}
              onChange={(e) => {
                const next = [...form.questions];
                next[i] = { ...qn, type: e.target.value };
                set("questions", next);
              }}
            >
              <option value="text">Short text</option>
              <option value="textarea">Long text</option>
              <option value="select">Dropdown</option>
              <option value="radio">Single choice</option>
              <option value="checkbox">Multiple choice</option>
              <option value="phone">Phone</option>
              <option value="email">E-mail</option>
            </Select>
            <Button variant="ghost" aria-label="Remove question" onClick={() => set("questions", form.questions.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
            {["select", "radio", "checkbox"].includes(qn.type) && (
              <Input
                className="sm:col-span-3"
                aria-label="Options"
                placeholder="Options, comma separated"
                value={(qn.options ?? []).join(", ")}
                onChange={(e) => {
                  const next = [...form.questions];
                  next[i] = { ...qn, options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) };
                  set("questions", next);
                }}
              />
            )}
            <label className="flex items-center gap-2 text-[13px] sm:col-span-3">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-accent)]"
                checked={qn.required}
                onChange={(e) => {
                  const next = [...form.questions];
                  next[i] = { ...qn, required: e.target.checked };
                  set("questions", next);
                }}
              />
              Required
            </label>
          </div>
        ))}
        <div>
          <Button size="sm" onClick={() => set("questions", [...form.questions, { id: `q${Date.now().toString(36)}`, label: "", type: "text", required: false }])}>
            <Plus className="size-3.5" /> Add question
          </Button>
        </div>
      </Section>

      <Section title="After booking">
        <Switch label="Require my confirmation" description="Bookings stay pending (and block the time) until you confirm them." checked={form.requiresConfirmation} onChange={(v) => set("requiresConfirmation", v)} />
        <Field label="Confirmation message" htmlFor="cmsg">
          <Textarea id="cmsg" value={form.confirmationMessage ?? ""} onChange={(e) => set("confirmationMessage", e.target.value)} placeholder="Shown after booking. Leave empty for the default text." />
        </Field>
        <Field label="Redirect to URL after booking" htmlFor="redir" hint="Optional, must start with https://">
          <Input id="redir" type="url" value={form.redirectUrl ?? ""} onChange={(e) => set("redirectUrl", e.target.value)} />
        </Field>
        <Field label="Brand color of the booking page" htmlFor="brand">
          <div className="flex items-center gap-2">
            <input id="brand" type="color" value={form.brandColor ?? "#1f7a5c"} onChange={(e) => set("brandColor", e.target.value)} className="h-9 w-12 rounded border border-line-strong bg-surface" />
            {form.brandColor && (
              <Button size="sm" variant="ghost" onClick={() => set("brandColor", null)}>
                Use default
              </Button>
            )}
          </div>
        </Field>
      </Section>

      <Section title="Visibility">
        <Switch label="Bookable" description="Turn off to hide the event and stop new bookings." checked={form.isActive} onChange={(v) => set("isActive", v)} />
        <Switch label="Private" description="Hidden from your public page. Only people with a private link can book." checked={form.isPrivate} onChange={(v) => set("isPrivate", v)} />
        {!isNew && (
          <div className="rounded-[var(--radius-control)] border border-line p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] text-muted">One-time links can be used for a single booking and expire after 30 days.</p>
              <Button size="sm" onClick={createLink}>
                <Link2 className="size-3.5" /> Create one-time link
              </Button>
            </div>
            {newLink && (
              <div className="mt-3 flex items-center gap-2 rounded bg-accent-soft p-2 text-[13px]">
                <code className="flex-1 break-all text-accent">{newLink}</code>
                <CopyButton value={newLink} />
              </div>
            )}
            {linksQ.data && linksQ.data.links.length > 0 && (
              <p className="mt-2 text-[12.5px] text-faint">
                {linksQ.data.links.filter((l) => !l.usedAt).length} unused, {linksQ.data.links.filter((l) => l.usedAt).length} used links.
              </p>
            )}
          </div>
        )}
      </Section>
    </form>
  );
}
