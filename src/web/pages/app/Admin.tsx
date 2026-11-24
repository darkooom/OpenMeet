import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner, Switch, Tabs } from "@/components/ui";
import { del, errorMessage, get, post, put } from "../../lib/api";
import { TIME_ZONES } from "../../lib/format";

interface Overview {
  version: string;
  config: { productName: string; defaultLocale: "en" | "de"; defaultTimezone: string; publicBaseUrl: string | null; registration: "open" | "invite_only" | "closed"; requireEmailVerification: boolean; retentionDays: number | null };
  credentials: { google: boolean; microsoft: boolean; zoom: boolean; email: boolean };
  secrets: { setupToken: boolean; encryptionKey: boolean };
  health: { database: string; dbLatencyMs: number };
  database: { counts: Record<string, number>; sizeBytes: number | null; migrations: { name: string; applied_at: string }[]; knownMigrations: string[] };
  jobs: Record<string, number>;
}

function System({ o }: { o: Overview }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Health">
        <dl className="grid grid-cols-[160px_1fr] gap-y-2 px-5 py-4 text-[13.5px]">
          <dt className="text-muted">Version</dt>
          <dd>{o.version}</dd>
          <dt className="text-muted">Database</dt>
          <dd>
            <Badge tone="accent">{o.health.database}</Badge> {o.health.dbLatencyMs} ms
          </dd>
          <dt className="text-muted">Database size</dt>
          <dd>{o.database.sizeBytes != null ? `${(o.database.sizeBytes / 1024 / 1024).toFixed(2)} MB` : "–"}</dd>
          <dt className="text-muted">Migrations</dt>
          <dd>
            {o.database.migrations.length}/{o.database.knownMigrations.length} applied
          </dd>
          <dt className="text-muted">Secrets</dt>
          <dd>
            SETUP_TOKEN {o.secrets.setupToken ? "set" : "missing"}, ENCRYPTION_KEY {o.secrets.encryptionKey ? "set" : "missing"}
          </dd>
          <dt className="text-muted">Jobs</dt>
          <dd>{Object.entries(o.jobs).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}</dd>
        </dl>
      </Panel>
      <Panel title="Records">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-5 py-4 text-[13px]">
          {Object.entries(o.database.counts).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <dt className="text-muted">{k}</dt>
              <dd className="tabular">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel title="Backup & export" className="lg:col-span-2">
        <div className="flex flex-col gap-3 px-5 py-4 text-[13.5px]">
          <p className="text-muted">
            D1 keeps point-in-time recovery (Time Travel) for 30 days. For off-site backups run <code>npx wrangler d1 export openmeet --remote --output backup.sql</code>. The JSON export below is a readable copy without secrets.
          </p>
          <a href="/api/admin/export" download className="self-start">
            <Button>Download instance export (JSON)</Button>
          </a>
        </div>
      </Panel>
    </div>
  );
}

function Config({ o, onSaved }: { o: Overview; onSaved: () => void }) {
  const [c, setC] = useState(o.config);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setC(o.config), [o.config]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await put("/api/admin/config", { ...c, publicBaseUrl: c.publicBaseUrl || null, retentionDays: c.retentionDays || null });
      setMsg("Saved");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <form onSubmit={save} className="flex max-w-[560px] flex-col gap-4">
      <ErrorNote>{error}</ErrorNote>
      <Field label="Product name" htmlFor="c-name">
        <Input id="c-name" value={c.productName} onChange={(e) => setC({ ...c, productName: e.target.value })} />
      </Field>
      <Field label="Public URL" htmlFor="c-url" hint="Used for links in e-mails and OAuth callbacks, e.g. https://meet.example.com">
        <Input id="c-url" type="url" value={c.publicBaseUrl ?? ""} onChange={(e) => setC({ ...c, publicBaseUrl: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Default language" htmlFor="c-lang">
          <Select id="c-lang" value={c.defaultLocale} onChange={(e) => setC({ ...c, defaultLocale: e.target.value as "en" | "de" })}>
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </Select>
        </Field>
        <Field label="Default time zone" htmlFor="c-tz">
          <Select id="c-tz" value={c.defaultTimezone} onChange={(e) => setC({ ...c, defaultTimezone: e.target.value })}>
            {TIME_ZONES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Registration" htmlFor="c-reg">
        <Select id="c-reg" value={c.registration} onChange={(e) => setC({ ...c, registration: e.target.value as typeof c.registration })}>
          <option value="invite_only">Invitation only</option>
          <option value="open">Open to everyone</option>
          <option value="closed">Closed (admins create accounts)</option>
        </Select>
      </Field>
      <Switch label="Require e-mail confirmation" description="Only applies when an e-mail provider is configured." checked={c.requireEmailVerification} onChange={(v) => setC({ ...c, requireEmailVerification: v })} />
      <Field label="Data retention (days)" htmlFor="c-ret" hint="Attendee data of meetings older than this is anonymised. Empty = keep. Minimum 30.">
        <Input id="c-ret" type="number" min={30} value={c.retentionDays ?? ""} onChange={(e) => setC({ ...c, retentionDays: e.target.value ? Number(e.target.value) : null })} />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary">
          Save configuration
        </Button>
        {msg && <span className="text-[13px] text-accent">{msg}</span>}
      </div>
    </form>
  );
}

function Credentials({ o, onSaved }: { o: Overview; onSaved: () => void }) {
  const [provider, setProvider] = useState<"email" | "google" | "microsoft" | "zoom">("email");
  const [f, setF] = useState<Record<string, string>>({ provider: "resend", tenant: "common" });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const origin = o.config.publicBaseUrl || window.location.origin;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      await put(`/api/admin/credentials/${provider}`, f);
      setMsg("Saved (stored encrypted).");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const fields: Record<typeof provider, [string, string, string?][]> = {
    email: [["fromEmail", "Sender address", "email"], ["fromName", "Sender name"], ["apiKey", "API key", "password"]],
    google: [["clientId", "Client ID"], ["clientSecret", "Client secret", "password"]],
    microsoft: [["clientId", "Application (client) ID"], ["clientSecret", "Client secret", "password"], ["tenant", "Tenant (common, organizations or tenant ID)"]],
    zoom: [["clientId", "Client ID"], ["clientSecret", "Client secret", "password"]],
  };
  return (
    <div className="flex max-w-[640px] flex-col gap-5">
      <ul className="flex flex-wrap gap-2 text-[13px]">
        {(["email", "google", "microsoft", "zoom"] as const).map((p) => (
          <li key={p}>
            <Badge tone={o.credentials[p] ? "accent" : "neutral"}>
              {p}: {o.credentials[p] ? "configured" : "not configured"}
            </Badge>
          </li>
        ))}
      </ul>
      <form onSubmit={save} className="flex flex-col gap-4 rounded-[var(--radius-panel)] border border-line bg-surface p-5">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Integration" htmlFor="cr-p">
          <Select id="cr-p" value={provider} onChange={(e) => { setProvider(e.target.value as typeof provider); setF({ provider: "resend", tenant: "common" }); setMsg(null); }}>
            <option value="email">E-mail provider</option>
            <option value="google">Google (sign-in, Calendar, Meet)</option>
            <option value="microsoft">Microsoft (sign-in, Outlook, Teams)</option>
            <option value="zoom">Zoom</option>
          </Select>
        </Field>
        {provider !== "email" && (
          <p className="text-[12.5px] text-muted">
            Redirect URI: <code className="break-all">{`${origin.replace(/\/+$/, "")}/auth/oauth/${provider}/callback`}</code>
          </p>
        )}
        {provider === "email" && (
          <Field label="Provider" htmlFor="cr-ep">
            <Select id="cr-ep" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
              <option value="resend">Resend</option>
              <option value="brevo">Brevo</option>
              <option value="postmark">Postmark</option>
            </Select>
          </Field>
        )}
        {fields[provider].map(([k, label, type]) => (
          <Field key={k} label={label} htmlFor={`cr-${k}`}>
            <Input id={`cr-${k}`} type={type ?? "text"} autoComplete="off" required value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </Field>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary">
            Save
          </Button>
          {o.credentials[provider] && (
            <Button variant="danger" onClick={async () => { await del(`/api/admin/credentials/${provider}`); onSaved(); }}>
              Remove
            </Button>
          )}
          {provider === "email" && o.credentials.email && (
            <Button onClick={async () => { const r = await post<{ message: string }>("/api/admin/credentials/email/test"); setMsg(r.message); }}>
              Send test e-mail
            </Button>
          )}
          {msg && <span className="text-[13px] text-accent">{msg}</span>}
        </div>
      </form>
    </div>
  );
}

function Users() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const q = useQuery({ queryKey: ["admin-users", search], queryFn: () => get<{ users: { id: string; name: string; email: string; username: string; isSuperAdmin: boolean; disabledAt: number | null; emailVerifiedAt: number | null; createdAt: number }[] }>(`/api/admin/users?q=${encodeURIComponent(search)}`) });
  const [f, setF] = useState({ name: "", email: "", username: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const update = async (id: string, body: object) => {
    try {
      await put(`/api/admin/users/${id}`, body);
    } catch (err) {
      alert(errorMessage(err));
    }
    void qc.invalidateQueries({ queryKey: ["admin-users"] });
  };
  return (
    <div className="flex flex-col gap-5">
      <Input type="search" aria-label="Search users" placeholder="Search users" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
      <Panel>
        <ul className="divide-y divide-line">
          {q.data?.users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div>
                <p className="font-medium">
                  {u.name} {u.isSuperAdmin && <Badge tone="accent">Admin</Badge>} {u.disabledAt && <Badge tone="danger">Disabled</Badge>} {!u.emailVerifiedAt && <Badge tone="warn">Unconfirmed</Badge>}
                </p>
                <p className="text-[13px] text-muted">
                  {u.email} /u/{u.username}
                </p>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => update(u.id, { isSuperAdmin: !u.isSuperAdmin })}>
                  {u.isSuperAdmin ? "Remove admin" : "Make admin"}
                </Button>
                <Button size="sm" variant={u.disabledAt ? "secondary" : "danger"} onClick={() => update(u.id, { disabled: !u.disabledAt })}>
                  {u.disabledAt ? "Enable" : "Disable"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <form
        className="flex max-w-[560px] flex-col gap-3 rounded-[var(--radius-panel)] border border-line bg-surface p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await post("/api/admin/users", f);
            setF({ name: "", email: "", username: "", password: "" });
            void qc.invalidateQueries({ queryKey: ["admin-users"] });
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <h2 className="font-sans text-[15px] font-semibold tracking-normal">Create user</h2>
        <ErrorNote>{error}</ErrorNote>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input aria-label="Name" placeholder="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input aria-label="E-mail" placeholder="E-mail" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <Input aria-label="Username" placeholder="Username" required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} />
          <Input aria-label="Initial password" placeholder="Initial password" type="password" minLength={10} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </div>
        <div>
          <Button type="submit">Create user</Button>
        </div>
      </form>
    </div>
  );
}

function Logs({ kind }: { kind: "audit" | "email" | "webhooks" | "jobs" | "orgs" }) {
  const qc = useQueryClient();
  const path = { audit: "/api/admin/audit-logs", email: "/api/admin/email-log", webhooks: "/api/admin/webhook-deliveries", jobs: "/api/admin/jobs?status=dead", orgs: "/api/admin/organizations" }[kind];
  const q = useQuery({ queryKey: ["admin-log", kind], queryFn: () => get<Record<string, Record<string, unknown>[]>>(path) });
  if (q.isLoading) return <Spinner />;
  const rows = Object.values(q.data ?? {})[0] ?? [];
  if (rows.length === 0) return <p className="text-muted">No entries.</p>;
  const cols = Object.keys(rows[0]!).filter((k) => !["id"].includes(k)).slice(0, 7);
  return (
    <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface">
      <table className="w-full text-[12.5px]">
        <thead className="text-left text-muted">
          <tr className="border-b border-line">
            {cols.map((c) => (
              <th key={c} className="px-3 py-2 font-medium">
                {c}
              </th>
            ))}
            {kind === "jobs" && <th />}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="max-w-[320px] truncate px-3 py-2" title={String(r[c] ?? "")}>
                  {/At$/.test(c) && typeof r[c] === "number" ? new Date(r[c] as number).toLocaleString() : String(r[c] ?? "")}
                </td>
              ))}
              {kind === "jobs" && (
                <td className="px-3">
                  <Button size="sm" onClick={async () => { await post(`/api/admin/jobs/${String(r.id)}/retry`); void qc.invalidateQueries({ queryKey: ["admin-log", "jobs"] }); }}>
                    Retry
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Tab = "system" | "config" | "credentials" | "users" | "orgs" | "audit" | "email" | "webhooks" | "jobs";

export default function Admin() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("system");
  const q = useQuery({ queryKey: ["admin-overview"], queryFn: () => get<Overview>("/api/admin/overview") });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-overview"] });
  return (
    <div>
      <PageHeader title="Administration" description="Instance-wide settings, users and logs." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "system", label: "System" },
          { value: "config", label: "Configuration" },
          { value: "credentials", label: "Integrations" },
          { value: "users", label: "Users" },
          { value: "orgs", label: "Organizations" },
          { value: "audit", label: "Audit log" },
          { value: "email", label: "E-mail log" },
          { value: "webhooks", label: "Webhook log" },
          { value: "jobs", label: "Failed jobs" },
        ]}
      />
      <div className="mt-6">
        {!q.data ? (
          <Spinner />
        ) : tab === "system" ? (
          <System o={q.data} />
        ) : tab === "config" ? (
          <Config o={q.data} onSaved={refresh} />
        ) : tab === "credentials" ? (
          <Credentials o={q.data} onSaved={refresh} />
        ) : tab === "users" ? (
          <Users />
        ) : (
          <Logs kind={tab} />
        )}
      </div>
    </div>
  );
}
