import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Badge, Button, Dialog, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner, Tabs, Textarea } from "@/components/ui";
import { del, errorMessage, get, post, put } from "../../lib/api";
import { TIME_ZONES } from "../../lib/format";
import { useSession, useUser } from "../../lib/session";
import { CopyButton } from "./Overview";

const SCOPES = ["event_types:read", "event_types:write", "bookings:read", "bookings:write", "availability:read", "teams:read", "users:read", "calendars:read", "webhooks:read", "webhooks:write", "agent"];
const EVENTS = ["booking.created", "booking.confirmed", "booking.cancelled", "booking.rescheduled", "booking.no_show"];

function Profile() {
  const user = useUser();
  const { refresh } = useSession();
  const [f, setF] = useState({ name: user.name, username: user.username, timezone: user.timezone, locale: user.locale, timeFormat: user.timeFormat, bio: user.bio ?? "", brandColor: user.brandColor ?? "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await put("/api/me/profile", { ...f, bio: f.bio || null, brandColor: f.brandColor || null });
      setMsg("Profile saved");
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="flex max-w-[560px] flex-col gap-4">
      <ErrorNote>{error}</ErrorNote>
      {!user.emailVerified && <ResendVerification />}
      <Field label="Name" htmlFor="p-name">
        <Input id="p-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Username" htmlFor="p-user" hint={`${window.location.origin}/u/${f.username}`}>
        <Input id="p-user" required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} />
      </Field>
      <Field label="About you" htmlFor="p-bio" hint="Shown on your public booking page.">
        <Textarea id="p-bio" rows={2} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Time zone" htmlFor="p-tz" className="sm:col-span-3">
          <Select id="p-tz" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
            {TIME_ZONES.map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </Select>
        </Field>
        <Field label="Language" htmlFor="p-lang">
          <Select id="p-lang" value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value })}>
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </Select>
        </Field>
        <Field label="Time format" htmlFor="p-tf">
          <Select id="p-tf" value={f.timeFormat} onChange={(e) => setF({ ...f, timeFormat: e.target.value })}>
            <option value="24h">24 hours</option>
            <option value="12h">12 hours</option>
          </Select>
        </Field>
        <Field label="Brand color" htmlFor="p-color">
          <input id="p-color" type="color" value={f.brandColor || "#1f7a5c"} onChange={(e) => setF({ ...f, brandColor: e.target.value })} className="h-9 w-full rounded border border-line-strong bg-surface" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" loading={busy}>
          Save profile
        </Button>
        {msg && <span className="text-[13px] text-accent">{msg}</span>}
      </div>
    </form>
  );
}

function ResendVerification() {
  const [sent, setSent] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
      Your e-mail address is not confirmed yet. Your public booking page stays hidden until it is.
      <Button size="sm" disabled={sent} onClick={async () => { await post("/api/auth/resend-verification"); setSent(true); }}>
        {sent ? "Sent" : "Resend e-mail"}
      </Button>
    </div>
  );
}

function Security() {
  const user = useUser();
  const [pw, setPw] = useState({ current: "", next: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => get<{ sessions: { id: string; current: boolean; createdAt: number; lastSeenAt: number; userAgent: string | null }[] }>("/api/auth/sessions") });
  const change = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await post("/api/auth/change-password", { currentPassword: pw.current || undefined, newPassword: pw.next });
      setMsg("Password changed. Other sessions were signed out.");
      setPw({ current: "", next: "" });
      void sessions.refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className="flex max-w-[640px] flex-col gap-8">
      <form onSubmit={change} className="flex flex-col gap-4">
        <h2 className="font-sans text-[15px] font-semibold tracking-normal">{user.hasPassword ? "Change password" : "Set a password"}</h2>
        <ErrorNote>{error}</ErrorNote>
        {msg && <p className="text-[13px] text-accent">{msg}</p>}
        {user.hasPassword && (
          <Field label="Current password" htmlFor="pw-cur">
            <Input id="pw-cur" type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
        )}
        <Field label="New password" htmlFor="pw-new" hint="At least 10 characters with letters and numbers.">
          <Input id="pw-new" type="password" autoComplete="new-password" minLength={10} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </Field>
        <div>
          <Button type="submit" variant="primary">
            Save password
          </Button>
        </div>
      </form>
      <Panel
        title="Active sessions"
        actions={
          <Button size="sm" variant="ghost" onClick={async () => { await post("/api/auth/sessions/revoke", { all: true }); void sessions.refetch(); }}>
            Sign out other sessions
          </Button>
        }
      >
        <ul className="divide-y divide-line">
          {sessions.data?.sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
              <div className="min-w-0">
                <p className="truncate">{s.userAgent ?? "Unknown device"}</p>
                <p className="text-muted">Last active {new Date(s.lastSeenAt).toLocaleString()}</p>
              </div>
              {s.current ? (
                <Badge tone="accent">This device</Badge>
              ) : (
                <Button size="sm" variant="ghost" onClick={async () => { await post("/api/auth/sessions/revoke", { id: s.id }); void sessions.refetch(); }}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["api-keys"], queryFn: () => get<{ apiKeys: { id: string; name: string; kind: string; prefix: string; scopes: string[]; lastUsedAt: number | null; revokedAt: number | null; expiresAt: number | null }[] }>("/api/me/api-keys") });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", kind: "user", scopes: ["bookings:read", "availability:read", "event_types:read"], expiresInDays: "" });
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await post<{ key: string }>("/api/me/api-keys", { name: f.name, kind: f.kind, scopes: f.scopes, expiresInDays: f.expiresInDays ? Number(f.expiresInDays) : null });
      setCreated(r.key);
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[64ch] text-muted">
        API keys give programs access to your data through the <a className="text-accent" href="/api/v1/openapi.json">REST API</a>. Service tokens with the <code>agent</code> scope are meant for AI assistants. Keys are shown once and stored hashed.
      </p>
      <div>
        <Button variant="primary" onClick={() => { setCreated(null); setF({ name: "", kind: "user", scopes: ["bookings:read", "availability:read", "event_types:read"], expiresInDays: "" }); setOpen(true); }}>
          <Plus className="size-4" /> New API key
        </Button>
      </div>
      <Panel>
        {!q.data?.apiKeys.length ? (
          <p className="px-5 py-6 text-muted">No API keys.</p>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.apiKeys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {k.name} {k.kind === "service" && <Badge>Service</Badge>} {k.revokedAt && <Badge tone="danger">Revoked</Badge>}
                  </p>
                  <p className="text-[12.5px] text-muted">
                    <code>{k.prefix}…</code> {k.scopes.join(", ")}
                  </p>
                  <p className="text-[12px] text-faint">{k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleString()}` : "Never used"}</p>
                </div>
                {!k.revokedAt && (
                  <Button size="sm" variant="danger" onClick={async () => { if (!confirm("Revoke this key? Programs using it stop working immediately.")) return; await del(`/api/me/api-keys/${k.id}`); void qc.invalidateQueries({ queryKey: ["api-keys"] }); }}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Dialog open={open} onClose={() => setOpen(false)} title="New API key" footer={created ? <Button onClick={() => setOpen(false)}>Done</Button> : <><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="key-form">Create key</Button></>}>
        {created ? (
          <div className="flex flex-col gap-3">
            <p>Copy the key now. You will not see it again.</p>
            <code className="break-all rounded bg-raised p-2 text-[12.5px]">{created}</code>
            <CopyButton value={created} />
          </div>
        ) : (
          <form id="key-form" onSubmit={create} className="flex flex-col gap-4">
            <ErrorNote>{error}</ErrorNote>
            <Field label="Name" htmlFor="k-name">
              <Input id="k-name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="CRM sync" />
            </Field>
            <Field label="Type" htmlFor="k-kind">
              <Select id="k-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, scopes: e.target.value === "service" ? ["agent"] : f.scopes })}>
                <option value="user">API key</option>
                <option value="service">Service token (AI agents)</option>
              </Select>
            </Field>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium">Scopes</legend>
              <div className="grid grid-cols-2 gap-1.5">
                {SCOPES.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={f.scopes.includes(s)} onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, s] : f.scopes.filter((x) => x !== s) })} />
                    <code>{s}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Expires after (days)" htmlFor="k-exp" hint="Empty = never">
              <Input id="k-exp" type="number" min={1} max={730} value={f.expiresInDays} onChange={(e) => setF({ ...f, expiresInDays: e.target.value })} />
            </Field>
          </form>
        )}
      </Dialog>
    </div>
  );
}

function Webhooks() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["webhooks"], queryFn: () => get<{ webhooks: { id: string; url: string; events: string[]; isActive: boolean }[]; deliveries: { id: string; webhookId: string; event: string; statusCode: number | null; success: boolean; error: string | null; createdAt: number }[] }>("/api/automation/webhooks") });
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["booking.created", "booking.cancelled", "booking.rescheduled"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await post<{ secret: string }>("/api/automation/webhooks", { url, events });
      setSecret(r.secret);
      setUrl("");
      void qc.invalidateQueries({ queryKey: ["webhooks"] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-[64ch] text-muted">
        OpenMeet sends a signed POST request for each event. Verify the <code>X-OpenMeet-Signature</code> header (<code>t=…,v1=HMAC-SHA256(secret, "t.body")</code>).
      </p>
      <form onSubmit={add} className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-5">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Endpoint URL" htmlFor="wh-url">
          <Input id="wh-url" type="url" required placeholder="https://example.com/openmeet" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
              <code>{ev}</code>
            </label>
          ))}
        </div>
        <div>
          <Button type="submit" variant="primary">
            Add webhook
          </Button>
        </div>
        {secret && (
          <div className="flex items-center gap-2 rounded bg-accent-soft p-2 text-[13px]">
            Signing secret (shown once): <code className="flex-1 break-all">{secret}</code>
            <CopyButton value={secret} />
          </div>
        )}
      </form>
      <Panel title="Endpoints">
        {!q.data?.webhooks.length ? (
          <p className="px-5 py-5 text-muted">No webhooks.</p>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.webhooks.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{w.url}</p>
                  <p className="text-[12.5px] text-muted">{w.events.join(", ")}</p>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" onClick={async () => { const r = await post<{ ok: boolean; status: number | null; error?: string }>(`/api/automation/webhooks/${w.id}/test`); alert(r.ok ? `Delivered (HTTP ${r.status})` : `Failed: ${r.error}`); void qc.invalidateQueries({ queryKey: ["webhooks"] }); }}>
                    Send test
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Delete webhook" onClick={async () => { await del(`/api/automation/webhooks/${w.id}`); void qc.invalidateQueries({ queryKey: ["webhooks"] }); }}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {q.data && q.data.deliveries.length > 0 && (
        <Panel title="Recent deliveries">
          <ul className="divide-y divide-line text-[13px]">
            {q.data.deliveries.slice(0, 15).map((d) => (
              <li key={d.id} className="flex justify-between gap-3 px-5 py-2">
                <span>
                  <code>{d.event}</code> {new Date(d.createdAt).toLocaleString()}
                </span>
                <Badge tone={d.success ? "accent" : "danger"}>{d.success ? `HTTP ${d.statusCode}` : (d.error ?? "failed")}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Embed() {
  const user = useUser();
  const origin = window.location.origin;
  const snippets = {
    inline: `<div data-openmeet-inline="${user.username}/30min" style="min-height:640px"></div>\n<script src="${origin}/embed.js" async></script>`,
    popup: `<button data-openmeet="${user.username}/30min">Book a meeting</button>\n<script src="${origin}/embed.js" async></script>`,
    floating: `<script src="${origin}/embed.js" data-openmeet-floating="${user.username}/30min" data-label="Book a meeting" async></script>`,
  };
  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <p className="text-muted">Add your booking page to any website. Replace <code>30min</code> with the URL name of an event type. Team events use <code>team/&lt;team&gt;/&lt;event&gt;</code>.</p>
      {(Object.entries(snippets) as [keyof typeof snippets, string][]).map(([k, v]) => (
        <div key={k}>
          <p className="mb-1.5 text-[13px] font-medium">{k === "inline" ? "Inline on the page" : k === "popup" ? "Popup from a button" : "Floating button"}</p>
          <pre className="overflow-x-auto rounded-[var(--radius-control)] border border-line bg-surface p-3 text-[12.5px]">{v}</pre>
          <div className="mt-2">
            <CopyButton value={v} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Privacy() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const user = useUser();
  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <div>
        <h2 className="font-sans text-[15px] font-semibold tracking-normal">Export your data</h2>
        <p className="mt-1 mb-3 text-muted">Download your profile, event types, schedules, bookings, contacts and settings as JSON.</p>
        <a href="/api/me/export" download>
          <Button>Download export</Button>
        </a>
      </div>
      <div className="border-t border-line pt-6">
        <h2 className="font-sans text-[15px] font-semibold tracking-normal text-danger">Delete account</h2>
        <p className="mt-1 mb-3 text-muted">Upcoming bookings are cancelled and attendees are informed. This cannot be undone.</p>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete my account
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Delete your account?"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Keep account</Button>
            <Button
              variant="danger"
              disabled={confirmText !== "DELETE"}
              onClick={async () => {
                setError(null);
                try {
                  await post("/api/me/delete-account", { password: pw || undefined, confirm: "DELETE" });
                  refresh();
                  navigate("/login");
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              Delete account
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <ErrorNote>{error}</ErrorNote>
          {user.hasPassword && (
            <Field label="Password" htmlFor="del-pw">
              <Input id="del-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
          )}
          <Field label='Type "DELETE" to confirm' htmlFor="del-confirm">
            <Input id="del-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

type Tab = "profile" | "security" | "api" | "webhooks" | "embed" | "privacy";

export default function Settings() {
  const [tab, setTab] = useState<Tab>("profile");
  const { me } = useSession();
  if (!me?.user) return <Spinner />;
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "profile", label: "Profile" },
          { value: "security", label: "Security" },
          { value: "api", label: "API keys" },
          { value: "webhooks", label: "Webhooks" },
          { value: "embed", label: "Embed" },
          { value: "privacy", label: "Privacy" },
        ]}
      />
      <div className="mt-6">
        {tab === "profile" && <Profile />}
        {tab === "security" && <Security />}
        {tab === "api" && <ApiKeys />}
        {tab === "webhooks" && <Webhooks />}
        {tab === "embed" && <Embed />}
        {tab === "privacy" && <Privacy />}
      </div>
    </div>
  );
}
