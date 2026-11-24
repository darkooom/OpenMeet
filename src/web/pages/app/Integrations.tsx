import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, RefreshCw, Trash2, Video } from "lucide-react";
import { Badge, Button, Dialog, ErrorNote, Field, Input, PageHeader, Panel, Spinner, cn } from "@/components/ui";
import { del, errorMessage, get, post, put } from "../../lib/api";

interface IntegrationsResponse {
  available: { google: boolean; microsoft: boolean; zoom: boolean; email: boolean };
  connections: {
    id: string;
    provider: "google" | "microsoft" | "ics" | "caldav" | "zoom";
    accountEmail: string | null;
    status: string;
    lastError: string | null;
    lastSyncedAt: number | null;
    calendars: { id: string; name: string; checkConflicts: boolean; isTarget: boolean; isPrimary: boolean }[];
  }[];
}

const NAMES = { google: "Google Calendar", microsoft: "Microsoft 365 / Outlook", ics: "ICS feed", caldav: "CalDAV", zoom: "Zoom" };

export default function Integrations() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ["integrations"], queryFn: () => get<IntegrationsResponse>("/api/integrations") });
  const [dialog, setDialog] = useState<null | "ics" | "caldav">(null);
  const [form, setForm] = useState({ name: "", url: "", username: "", password: "" });
  const [error, setError] = useState<string | null>(params.get("error") ? `Connection failed (${params.get("error")}).` : null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["integrations"] });

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (dialog === "ics") await post("/api/integrations/ics", { name: form.name, url: form.url });
      else await post("/api/integrations/caldav", { url: form.url, username: form.username, password: form.password });
      setDialog(null);
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const a = q.data?.available;
  const providers = [
    { key: "google", title: "Google Calendar", desc: "Check conflicts, add bookings to your calendar and create Google Meet links.", href: "/auth/oauth/google/start?purpose=calendar", ok: a?.google, icon: CalendarDays },
    { key: "microsoft", title: "Microsoft 365 / Outlook", desc: "Check conflicts, add bookings to Outlook and create Teams meetings.", href: "/auth/oauth/microsoft/start?purpose=calendar", ok: a?.microsoft, icon: CalendarDays },
    { key: "zoom", title: "Zoom", desc: "Create a Zoom meeting for every booking that uses Zoom as location.", href: "/auth/oauth/zoom/start?purpose=zoom", ok: a?.zoom, icon: Video },
  ];

  return (
    <div>
      <PageHeader title="Integrations" description="Connect calendars to avoid double bookings and to create events and meeting links automatically." />
      <ErrorNote>{error && !dialog ? error : null}</ErrorNote>
      {params.get("connected") && <p className="mb-4 rounded-[var(--radius-control)] bg-accent-soft px-3 py-2 text-[13.5px] text-accent">Connected. Choose which calendars to check below.</p>}

      <Panel title="Connected">
        {q.isLoading ? (
          <div className="p-5">
            <Spinner />
          </div>
        ) : !q.data?.connections.length ? (
          <p className="px-5 py-6 text-muted">Nothing connected yet. Bookings are still protected against internal double booking.</p>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.connections.map((c) => (
              <li key={c.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {NAMES[c.provider]} <span className="font-normal text-muted">{c.accountEmail}</span>
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-[12.5px] text-muted">
                      <span className={cn("size-2 rounded-full", c.status === "active" && !c.lastError ? "bg-accent" : "bg-danger")} />
                      {c.status !== "active" ? `Connection ${c.status} – reconnect` : c.lastError ? c.lastError : c.lastSyncedAt ? `Last checked ${new Date(c.lastSyncedAt).toLocaleString()}` : "Connected"}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {c.provider !== "zoom" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await post(`/api/integrations/${c.id}/refresh`);
                          } catch (err) {
                            setError(errorMessage(err));
                          }
                          refresh();
                        }}
                      >
                        <RefreshCw className="size-3.5" /> Sync
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Disconnect"
                      onClick={async () => {
                        if (!confirm(`Disconnect ${NAMES[c.provider]}?`)) return;
                        await del(`/api/integrations/${c.id}`);
                        refresh();
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                {c.calendars.length > 0 && (
                  <table className="mt-3 w-full text-[13px]">
                    <thead className="text-left text-[12px] text-muted">
                      <tr>
                        <th className="py-1 font-medium">Calendar</th>
                        <th className="py-1 text-center font-medium">Check for conflicts</th>
                        <th className="py-1 text-center font-medium">Add bookings here</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.calendars.map((cal) => (
                        <tr key={cal.id} className="border-t border-line">
                          <td className="py-2">
                            {cal.name} {cal.isPrimary && <Badge>Primary</Badge>}
                          </td>
                          <td className="py-2 text-center">
                            <input
                              type="checkbox"
                              aria-label={`Check ${cal.name} for conflicts`}
                              className="size-4 accent-[var(--color-accent)]"
                              checked={cal.checkConflicts}
                              onChange={async (e) => {
                                await put(`/api/integrations/calendars/${cal.id}`, { checkConflicts: e.target.checked });
                                refresh();
                              }}
                            />
                          </td>
                          <td className="py-2 text-center">
                            {c.provider === "ics" ? (
                              <span className="text-faint">read-only</span>
                            ) : (
                              <input
                                type="radio"
                                name="target-calendar"
                                aria-label={`Add bookings to ${cal.name}`}
                                className="size-4 accent-[var(--color-accent)]"
                                checked={cal.isTarget}
                                onChange={async () => {
                                  await put(`/api/integrations/calendars/${cal.id}`, { isTarget: true });
                                  refresh();
                                }}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <h2 className="mt-8 mb-3 font-sans text-[15px] font-semibold tracking-normal">Add a connection</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {providers.map((p) => (
          <div key={p.key} className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-line bg-surface p-5">
            <p className="flex items-center gap-2 font-medium">
              <p.icon className="size-4 text-muted" /> {p.title}
            </p>
            <p className="flex-1 text-[13px] text-muted">{p.desc}</p>
            {p.ok ? (
              <a href={p.href} className="self-start">
                <Button size="sm">Connect</Button>
              </a>
            ) : (
              <p className="text-[12.5px] text-warn">Not available: an administrator has to add the OAuth app first (Administration → Integrations).</p>
            )}
          </div>
        ))}
        <div className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-line bg-surface p-5">
          <p className="font-medium">CalDAV</p>
          <p className="flex-1 text-[13px] text-muted">iCloud, Fastmail, Nextcloud and other CalDAV servers. Use an app-specific password.</p>
          <Button size="sm" className="self-start" onClick={() => { setForm({ name: "", url: "", username: "", password: "" }); setError(null); setDialog("caldav"); }}>
            Connect
          </Button>
        </div>
        <div className="flex flex-col gap-2 rounded-[var(--radius-panel)] border border-line bg-surface p-5">
          <p className="font-medium">ICS feed (read-only)</p>
          <p className="flex-1 text-[13px] text-muted">Subscribe to any calendar's secret iCal address to block busy times.</p>
          <Button size="sm" className="self-start" onClick={() => { setForm({ name: "", url: "", username: "", password: "" }); setError(null); setDialog("ics"); }}>
            Add feed
          </Button>
        </div>
      </div>

      <Dialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={dialog === "ics" ? "Add ICS feed" : "Connect CalDAV"}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form="int-form" loading={busy}>
              Connect
            </Button>
          </>
        }
      >
        <form id="int-form" onSubmit={add} className="flex flex-col gap-4">
          <ErrorNote>{error}</ErrorNote>
          {dialog === "ics" && (
            <Field label="Name" htmlFor="ics-name">
              <Input id="ics-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
          )}
          <Field label={dialog === "ics" ? "Feed URL (https or webcal)" : "Calendar collection URL"} htmlFor="int-url">
            <Input id="int-url" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </Field>
          {dialog === "caldav" && (
            <>
              <Field label="Username" htmlFor="cd-user">
                <Input id="cd-user" required autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </Field>
              <Field label="App password" htmlFor="cd-pw" hint="Stored encrypted on the server.">
                <Input id="cd-pw" type="password" required autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </Field>
            </>
          )}
        </form>
      </Dialog>
    </div>
  );
}
