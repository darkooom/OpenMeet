import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarCheck, Clock, Download, MapPin, Phone, Users, Video } from "lucide-react";
import { Button, ErrorNote, Field, Input, Select, Spinner, Textarea, cn } from "@/components/ui";
import { ApiError, errorMessage, get, post } from "../../lib/api";
import { LOCATION_LABELS, browserLocale, browserTimeZone, fmtDate, fmtRange, minutesLabel } from "../../lib/format";
import { SlotPicker, type SlotsResponse } from "./SlotPicker";

export interface PublicEventType {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  kind: "one_on_one" | "group" | "collective" | "round_robin";
  duration: number;
  durationOptions: number[];
  color: string;
  brandColor: string | null;
  locations: { type: string; value: string | null }[];
  questions: { id: string; label: string; type: string; required: boolean; options?: string[] }[];
  seats: number;
  requiresConfirmation: boolean;
  confirmationMessage: string | null;
  redirectUrl: string | null;
  hosts: { name: string; username: string; avatarUrl: string | null }[];
  team: { name: string; slug: string; logoUrl: string | null } | null;
}

interface BookingResult {
  booking: { id: string; status: string; startAt: number; endAt: number; meetingUrl: string | null; locationType: string | null; locationValue: string | null; hosts: { name: string }[] };
  manageToken: string | null;
  emailEnabled?: boolean;
}

export function useEmbed() {
  const [params] = useSearchParams();
  const embed = params.get("embed") === "1";
  useEffect(() => {
    if (!embed || window.parent === window) return;
    document.documentElement.classList.add("om-embed");
    const send = () => window.parent.postMessage({ source: "openmeet", type: "resize", height: document.documentElement.scrollHeight }, "*");
    const ro = new ResizeObserver(send);
    ro.observe(document.body);
    send();
    return () => ro.disconnect();
  }, [embed]);
  const theme = params.get("theme");
  useEffect(() => {
    if (theme === "dark" || theme === "light") document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  return embed;
}

export function LocationIcon({ type, className = "size-4" }: { type: string | null; className?: string }) {
  if (type === "phone" || type === "attendee_phone") return <Phone className={className} aria-hidden />;
  if (type === "in_person") return <MapPin className={className} aria-hidden />;
  return <Video className={className} aria-hidden />;
}

export function Avatar({ name, src, size = 40 }: { name: string; src?: string | null; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  if (src) return <img src={src} alt="" width={size} height={size} className="rounded-full object-cover" style={{ width: size, height: size }} />;
  return (
    <span className="grid place-items-center rounded-full bg-raised font-semibold text-muted" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {initials}
    </span>
  );
}

export function PublicFrame({ children, embed }: { children: ReactNode; embed?: boolean }) {
  return (
    <div className={cn("min-h-dvh", embed ? "bg-transparent" : "bg-paper px-4 py-8 sm:py-16")}>
      <div className={cn("mx-auto w-full max-w-[1000px]", !embed && "animate-rise")}>{children}</div>
      {!embed && (
        <p className="mt-8 text-center text-[12px] text-faint">
          Scheduling by <a href="https://github.com/darkooom/OpenMeet" className="underline-offset-2 hover:underline">OpenMeet</a>
        </p>
      )}
    </div>
  );
}

function googleCalendarUrl(title: string, start: number, end: number, details: string) {
  const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const p = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${f(start)}/${f(end)}`, details });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export default function BookingPage({ mode }: { mode: "user" | "team" | "link" }) {
  const params = useParams();
  const [search] = useSearchParams();
  const embed = useEmbed();
  const lang = browserLocale();
  const path =
    mode === "user" ? `/api/public/users/${params.username}/${params.slug}` : mode === "team" ? `/api/public/teams/${params.teamSlug}/${params.slug}` : `/api/public/links/${params.token}`;
  const q = useQuery({ queryKey: ["public-et", path], queryFn: () => get<{ eventType: PublicEventType }>(path), retry: false });
  const et = q.data?.eventType;

  const [timezone, setTimezone] = useState(browserTimeZone());
  const [duration, setDuration] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);
  const viewed = useRef(false);

  useEffect(() => {
    if (et && !viewed.current) {
      viewed.current = true;
      void post(`/api/public/event-types/${et.id}/view`).catch(() => undefined);
      document.title = `${et.title} – ${et.team?.name ?? et.hosts[0]?.name ?? "OpenMeet"}`;
    }
  }, [et]);

  if (q.isLoading) {
    return (
      <PublicFrame embed={embed}>
        <div className="grid min-h-[50vh] place-items-center">
          <Spinner />
        </div>
      </PublicFrame>
    );
  }
  if (!et) {
    const gone = q.error instanceof ApiError && q.error.status === 410;
    return (
      <PublicFrame embed={embed}>
        <div className="mx-auto max-w-md py-20">
          <h1 className="text-2xl">{gone ? "This booking link is no longer valid" : "This page does not exist"}</h1>
          <p className="mt-2 text-muted">{gone ? "One-time links can only be used once. Ask the organizer for a new link." : "Check the link you received, or contact the person who shared it."}</p>
        </div>
      </PublicFrame>
    );
  }

  const dur = duration ?? et.duration;
  const accent = et.brandColor;
  const durations = [et.duration, ...et.durationOptions].sort((a, b) => a - b);

  return (
    <PublicFrame embed={embed}>
      <div className="overflow-hidden rounded-[16px] border border-line bg-surface shadow-[0_1px_0_rgba(0,0,0,0.02),0_12px_40px_-24px_rgba(20,30,40,0.25)] md:grid md:grid-cols-[300px_1fr]" style={accent ? ({ "--color-accent": accent } as React.CSSProperties) : undefined}>
        <aside className="border-b border-line p-6 md:border-b-0 md:border-r md:p-8">
          <div className="flex -space-x-2">
            {et.hosts.slice(0, 4).map((h) => (
              <span key={h.username} className="rounded-full ring-2 ring-surface">
                <Avatar name={h.name} src={h.avatarUrl} size={44} />
              </span>
            ))}
          </div>
          <p className="mt-4 text-[13px] text-muted">{et.team ? et.team.name : et.hosts.map((h) => h.name).join(", ")}</p>
          <h1 className="mt-1 text-[26px] leading-tight">{et.title}</h1>
          <ul className="mt-5 flex flex-col gap-2.5 text-[13.5px] text-muted">
            <li className="flex items-center gap-2.5">
              <Clock className="size-4" aria-hidden /> {minutesLabel(dur)}
            </li>
            {et.locations.slice(0, 1).map((l) => (
              <li key={l.type} className="flex items-center gap-2.5">
                <LocationIcon type={l.type} /> {LOCATION_LABELS[l.type] ?? l.type}
                {et.locations.length > 1 && ` +${et.locations.length - 1}`}
              </li>
            ))}
            {et.kind === "group" && (
              <li className="flex items-center gap-2.5">
                <Users className="size-4" aria-hidden /> Group session, up to {et.seats} people
              </li>
            )}
            {et.requiresConfirmation && (
              <li className="flex items-center gap-2.5">
                <CalendarCheck className="size-4" aria-hidden /> Confirmed by the organizer
              </li>
            )}
          </ul>
          {picked && !result && (
            <p className="mt-5 rounded-[var(--radius-control)] bg-accent-soft px-3 py-2 text-[13px] font-medium text-accent">
              {fmtDate(picked, timezone, lang)}
              <br />
              {fmtRange(picked, picked + dur * 60_000, timezone, lang)}
            </p>
          )}
          {et.description && <p className="mt-5 whitespace-pre-line text-[13.5px] leading-relaxed text-muted">{et.description}</p>}
          {durations.length > 1 && !picked && !result && (
            <div className="mt-6" role="radiogroup" aria-label="Duration">
              <p className="mb-2 text-[13px] font-medium">Duration</p>
              <div className="flex flex-wrap gap-1.5">
                {durations.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={dur === d}
                    onClick={() => setDuration(d)}
                    className={cn("rounded-full border px-3 py-1 text-[13px]", dur === d ? "border-accent bg-accent text-accent-ink" : "border-line-strong text-muted hover:text-ink")}
                  >
                    {minutesLabel(d)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        <section className="p-6 md:p-8">
          {result ? (
            <Confirmation et={et} result={result} timezone={timezone} lang={lang} embed={embed} />
          ) : picked ? (
            <BookingForm
              et={et}
              start={picked}
              duration={dur}
              timezone={timezone}
              lang={lang}
              privateToken={mode === "link" ? params.token : undefined}
              prefill={{ name: search.get("name") ?? "", email: search.get("email") ?? "" }}
              utm={Object.fromEntries([...search.entries()].filter(([k]) => k.startsWith("utm_")))}
              source={embed ? "embed" : (search.get("source") ?? undefined)}
              onBack={() => setPicked(null)}
              onBooked={(r) => {
                setResult(r);
                if (embed) window.parent.postMessage({ source: "openmeet", type: "booked", bookingId: r.booking.id, startAt: r.booking.startAt }, "*");
              }}
            />
          ) : (
            <>
              <h2 className="sr-only">Select a date and time</h2>
              <SlotPicker
                queryKey={["slots", et.id, dur, mode === "link" ? params.token : ""]}
                fetchSlots={(from, to) => get<SlotsResponse>(`/api/public/event-types/${et.id}/slots?from=${from}&to=${to}&duration=${dur}${mode === "link" ? `&token=${encodeURIComponent(params.token ?? "")}` : ""}`)}
                timezone={timezone}
                onTimezoneChange={setTimezone}
                onPick={setPicked}
                lang={lang}
              />
            </>
          )}
        </section>
      </div>
    </PublicFrame>
  );
}

function BookingForm({
  et,
  start,
  duration,
  timezone,
  lang,
  privateToken,
  prefill,
  utm,
  source,
  onBack,
  onBooked,
}: {
  et: PublicEventType;
  start: number;
  duration: number;
  timezone: string;
  lang: string;
  privateToken?: string;
  prefill: { name: string; email: string };
  utm: Record<string, string>;
  source?: string;
  onBack: () => void;
  onBooked: (r: BookingResult) => void;
}) {
  const [name, setName] = useState(prefill.name);
  const [email, setEmail] = useState(prefill.email);
  const [location, setLocation] = useState(et.locations[0]?.type ?? "");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const idempotencyKey = useMemo(() => crypto.randomUUID().replace(/-/g, ""), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErr(null);
    try {
      const res = await fetch("/api/public/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-openmeet-csrf": "1", "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          eventTypeId: et.id,
          start,
          duration,
          name,
          email,
          timezone,
          locale: lang,
          location: location ? { type: location, value: location === "attendee_phone" ? phone : undefined } : undefined,
          answers,
          privateLinkToken: privateToken,
          utm: Object.keys(utm).length ? utm : undefined,
          source,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? "Booking failed", data?.error?.details);
      onBooked(data as BookingResult);
    } catch (err) {
      if (err instanceof ApiError && err.details && typeof err.details === "object" && "field" in err.details) setFieldErr(String((err.details as { field: string }).field));
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex max-w-[460px] flex-col gap-4 animate-rise">
      <button type="button" onClick={onBack} className="flex items-center gap-1.5 self-start text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Choose another time
      </button>
      <h2 className="text-[20px]">Your details</h2>
      <p className="-mt-2 text-[13px] text-muted">
        {fmtDate(start, timezone, lang)}, {fmtRange(start, start + duration * 60_000, timezone, lang)}
      </p>
      <ErrorNote>{error}</ErrorNote>
      <Field label="Name" htmlFor="b-name">
        <Input id="b-name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="E-mail" htmlFor="b-email" hint="The confirmation and calendar invite are sent here.">
        <Input id="b-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {et.locations.length > 1 && (
        <Field label="Where should we meet?" htmlFor="b-loc">
          <Select id="b-loc" value={location} onChange={(e) => setLocation(e.target.value)}>
            {et.locations.map((l) => (
              <option key={l.type} value={l.type}>
                {LOCATION_LABELS[l.type] ?? l.type}
                {l.value ? ` – ${l.value}` : ""}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {location === "attendee_phone" && (
        <Field label="Phone number" htmlFor="b-phone">
          <Input id="b-phone" type="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      )}
      {et.questions.map((qn) => {
        const id = `q-${qn.id}`;
        const val = answers[qn.id];
        const set = (v: string | string[]) => setAnswers({ ...answers, [qn.id]: v });
        const label = (
          <>
            {qn.label}
            {!qn.required && <span className="font-normal text-faint"> (optional)</span>}
          </>
        );
        const err = fieldErr === qn.id ? "This field is required" : null;
        if (qn.type === "textarea") return <Field key={qn.id} label={label} htmlFor={id} error={err}><Textarea id={id} required={qn.required} value={(val as string) ?? ""} onChange={(e) => set(e.target.value)} /></Field>;
        if (qn.type === "select")
          return (
            <Field key={qn.id} label={label} htmlFor={id} error={err}>
              <Select id={id} required={qn.required} value={(val as string) ?? ""} onChange={(e) => set(e.target.value)}>
                <option value="">Select…</option>
                {qn.options?.map((o) => <option key={o}>{o}</option>)}
              </Select>
            </Field>
          );
        if (qn.type === "radio" || qn.type === "checkbox")
          return (
            <fieldset key={qn.id} className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[13px] font-medium">{label}</legend>
              {qn.options?.map((o) => {
                const checked = qn.type === "radio" ? val === o : Array.isArray(val) && val.includes(o);
                return (
                  <label key={o} className="flex items-center gap-2 text-sm">
                    <input
                      type={qn.type}
                      name={id}
                      required={qn.required && qn.type === "radio"}
                      checked={checked}
                      onChange={() => (qn.type === "radio" ? set(o) : set(checked ? (val as string[]).filter((x) => x !== o) : [...((val as string[]) ?? []), o]))}
                      className="size-4 accent-[var(--color-accent)]"
                    />
                    {o}
                  </label>
                );
              })}
            </fieldset>
          );
        return (
          <Field key={qn.id} label={label} htmlFor={id} error={err}>
            <Input id={id} type={qn.type === "email" ? "email" : qn.type === "phone" ? "tel" : "text"} required={qn.required} value={(val as string) ?? ""} onChange={(e) => set(e.target.value)} />
          </Field>
        );
      })}
      <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-2">
        {et.requiresConfirmation ? "Request booking" : "Confirm booking"}
      </Button>
      <p className="text-[12px] text-faint">Your details are only shared with the organizer of this meeting.</p>
    </form>
  );
}

function Confirmation({ et, result, timezone, lang, embed }: { et: PublicEventType; result: BookingResult; timezone: string; lang: string; embed: boolean }) {
  const b = result.booking;
  const pending = b.status === "pending";
  const [countdown, setCountdown] = useState(et.redirectUrl && !embed ? 5 : null);
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) {
      window.location.href = et.redirectUrl!;
      return;
    }
    const t = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, et.redirectUrl]);
  const where = b.meetingUrl ?? b.locationValue ?? (b.locationType ? LOCATION_LABELS[b.locationType] : null);
  return (
    <div className="max-w-[480px] animate-rise" role="status">
      <div className="grid size-11 place-items-center rounded-full bg-accent text-accent-ink">
        <CalendarCheck className="size-5" />
      </div>
      <h2 className="mt-4 text-[26px] leading-tight">{pending ? "Request sent" : "You're booked"}</h2>
      <p className="mt-2 text-muted">
        {et.confirmationMessage ??
          (pending
            ? result.emailEnabled
              ? "The organizer will confirm your request. You will get an e-mail either way."
              : "The organizer will confirm your request."
            : result.emailEnabled
              ? "A confirmation with a calendar invite is on its way to your inbox."
              : "Save the date with the buttons below. Keep this page’s links to reschedule or cancel.")}
      </p>
      <dl className="mt-6 grid grid-cols-[88px_1fr] gap-y-3 border-y border-line py-5 text-[14px]">
        <dt className="text-muted">What</dt>
        <dd>{et.title}</dd>
        <dt className="text-muted">When</dt>
        <dd>
          {fmtDate(b.startAt, timezone, lang)}
          <br />
          {fmtRange(b.startAt, b.endAt, timezone, lang)} <span className="text-faint">({timezone.replace(/_/g, " ")})</span>
        </dd>
        <dt className="text-muted">With</dt>
        <dd>{b.hosts.map((h) => h.name).join(", ")}</dd>
        {where && (
          <>
            <dt className="text-muted">Where</dt>
            <dd className="break-all">{b.meetingUrl ? <a href={b.meetingUrl} className="text-accent underline-offset-2 hover:underline">{b.meetingUrl}</a> : where}</dd>
          </>
        )}
      </dl>
      {result.manageToken && (
        <div className="mt-5 flex flex-wrap gap-2">
          <a href={`/api/public/bookings/${result.manageToken}/ics`} className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-line-strong px-3 text-sm font-medium hover:bg-raised">
            <Download className="size-4" /> Add to calendar (.ics)
          </a>
          <a
            href={googleCalendarUrl(et.title, b.startAt, b.endAt, b.meetingUrl ?? "")}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-9 items-center rounded-[var(--radius-control)] border border-line-strong px-3 text-sm font-medium hover:bg-raised"
          >
            Google Calendar
          </a>
        </div>
      )}
      {result.manageToken && (
        <p className="mt-5 text-[13px] text-muted">
          Need a change?{" "}
          {et.kind !== "group" && (
            <>
              <a className="text-accent" href={`/reschedule/${result.manageToken}`}>
                Reschedule
              </a>{" "}
              or{" "}
            </>
          )}
          <a className="text-accent" href={`/cancel/${result.manageToken}`}>
            cancel
          </a>
          .
        </p>
      )}
      {countdown != null && <p className="mt-4 text-[13px] text-faint">Redirecting in {countdown} s…</p>}
    </div>
  );
}
