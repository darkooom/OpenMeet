import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Badge, Button, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner } from "@/components/ui";
import { del, errorMessage, get, post, put } from "../../lib/api";
import { useUser } from "../../lib/session";
import { CopyButton } from "./Overview";

interface OrgDetail {
  organization: { id: string; name: string; slug: string; brandColor: string | null };
  role: "owner" | "admin" | "member";
  members: { id: string; name: string; email: string; username: string; role: string }[];
  teams: { id: string; name: string; slug: string; description: string | null; members: { userId: string; role: string }[] }[];
  invitations: { id: string; email: string; role: string; expiresAt: number; teamId: string | null }[];
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export default function Teams() {
  const user = useUser();
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: () => get<{ organizations: { id: string; name: string; role: string }[] }>("/api/orgs") });
  const [orgId, setOrgId] = useState<string | null>(null);
  const currentOrg = orgId ?? orgs.data?.organizations[0]?.id ?? null;
  const detail = useQuery({ queryKey: ["org", currentOrg], enabled: !!currentOrg, queryFn: () => get<OrgDetail>(`/api/orgs/${currentOrg}`) });
  const [dialog, setDialog] = useState<null | "org" | "team" | "invite">(null);
  const [form, setForm] = useState({ name: "", slug: "", email: "", role: "member", teamId: "" });
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = detail.data?.role === "owner" || detail.data?.role === "admin";
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["org", currentOrg] });
    void qc.invalidateQueries({ queryKey: ["orgs"] });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (dialog === "org") {
        const r = await post<{ id: string }>("/api/orgs", { name: form.name, slug: form.slug });
        setOrgId(r.id);
        setDialog(null);
      } else if (dialog === "team") {
        await post(`/api/orgs/${currentOrg}/teams`, { name: form.name, slug: form.slug });
        setDialog(null);
      } else if (dialog === "invite") {
        const r = await post<{ url: string }>(`/api/orgs/${currentOrg}/invitations`, { email: form.email, role: form.role, teamId: form.teamId || null });
        setInviteUrl(r.url);
      }
      refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const open = (d: "org" | "team" | "invite") => {
    setForm({ name: "", slug: "", email: "", role: "member", teamId: "" });
    setError(null);
    setInviteUrl(null);
    setDialog(d);
  };

  if (orgs.isLoading) return <Spinner />;
  const d = detail.data;
  const memberName = (id: string) => d?.members.find((m) => m.id === id)?.name ?? id;

  return (
    <div>
      <PageHeader
        title="Teams"
        description="Organizations, teams and shared scheduling."
        actions={
          <>
            {orgs.data && orgs.data.organizations.length > 1 && (
              <Select aria-label="Organization" value={currentOrg ?? ""} onChange={(e) => setOrgId(e.target.value)} className="w-48">
                {orgs.data.organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            )}
            <Button onClick={() => open("org")}>New organization</Button>
          </>
        }
      />
      {!currentOrg ? (
        <Panel>
          <EmptyState icon={<Users className="size-6" />} title="You are not part of an organization" action={<Button variant="primary" onClick={() => open("org")}>Create organization</Button>}>
            Organizations let you invite colleagues and offer round-robin or collective meetings.
          </EmptyState>
        </Panel>
      ) : !d ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-6">
          <Panel
            title={`Teams in ${d.organization.name}`}
            actions={
              isAdmin && (
                <Button size="sm" onClick={() => open("team")}>
                  <Plus className="size-3.5" /> New team
                </Button>
              )
            }
          >
            {d.teams.length === 0 ? (
              <p className="px-5 py-6 text-muted">No teams yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {d.teams.map((t) => {
                  const mine = t.members.find((m) => m.userId === user.id);
                  const canManage = isAdmin || mine?.role === "manager";
                  const nonMembers = d.members.filter((m) => !t.members.some((tm) => tm.userId === m.id));
                  return (
                    <li key={t.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="font-medium">{t.name}</p>
                          <a href={`/team/${t.slug}`} target="_blank" rel="noreferrer" className="text-[13px] text-accent">
                            /team/{t.slug}
                          </a>
                        </div>
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Delete team"
                            onClick={async () => {
                              if (!confirm(`Delete team "${t.name}" and its event types?`)) return;
                              await del(`/api/orgs/teams/${t.id}`);
                              refresh();
                            }}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {t.members.map((m) => (
                          <li key={m.userId} className="flex items-center gap-1.5 rounded-full border border-line py-1 pr-1 pl-3 text-[13px]">
                            {memberName(m.userId)}
                            {m.role === "manager" && <Badge tone="accent">Manager</Badge>}
                            {canManage && (
                              <button
                                type="button"
                                aria-label={`Remove ${memberName(m.userId)} from team`}
                                onClick={async () => {
                                  await del(`/api/orgs/teams/${t.id}/members/${m.userId}`);
                                  refresh();
                                }}
                                className="rounded-full p-1 text-faint hover:text-danger"
                              >
                                <Trash2 className="size-3" />
                              </button>
                            )}
                          </li>
                        ))}
                        {canManage && nonMembers.length > 0 && (
                          <li>
                            <Select
                              aria-label="Add member to team"
                              value=""
                              onChange={async (e) => {
                                if (!e.target.value) return;
                                await post(`/api/orgs/teams/${t.id}/members`, { userId: e.target.value, role: "member" });
                                refresh();
                              }}
                              className="w-48"
                            >
                              <option value="">Add member…</option>
                              {nonMembers.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </Select>
                          </li>
                        )}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel
            title="Members"
            actions={
              isAdmin && (
                <Button size="sm" onClick={() => open("invite")}>
                  <UserPlus className="size-3.5" /> Invite
                </Button>
              )
            }
          >
            <ul className="divide-y divide-line">
              {d.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {m.name} {m.id === user.id && <span className="text-faint">(you)</span>}
                    </p>
                    <p className="text-[13px] text-muted">{m.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isAdmin && m.id !== user.id ? (
                      <Select
                        aria-label={`Role of ${m.name}`}
                        value={m.role}
                        onChange={async (e) => {
                          try {
                            await put(`/api/orgs/${currentOrg}/members/${m.id}`, { role: e.target.value });
                          } catch (err) {
                            alert(errorMessage(err));
                          }
                          refresh();
                        }}
                        className="w-32"
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                        {d.role === "owner" && <option value="owner">Owner</option>}
                      </Select>
                    ) : (
                      <Badge>{m.role}</Badge>
                    )}
                    {isAdmin && m.id !== user.id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${m.name}`}
                        onClick={async () => {
                          if (!confirm(`Remove ${m.name} from ${d.organization.name}?`)) return;
                          try {
                            await del(`/api/orgs/${currentOrg}/members/${m.id}`);
                          } catch (err) {
                            alert(errorMessage(err));
                          }
                          refresh();
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {d.invitations.length > 0 && (
              <div className="border-t border-line px-5 py-3">
                <p className="mb-2 text-[13px] font-medium text-muted">Pending invitations</p>
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {d.invitations.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2">
                      <span>
                        {i.email} <span className="text-faint">as {i.role}</span>
                      </span>
                      <button
                        type="button"
                        className="text-danger"
                        onClick={async () => {
                          await del(`/api/orgs/${currentOrg}/invitations/${i.id}`);
                          refresh();
                        }}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        </div>
      )}

      <Dialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        title={dialog === "org" ? "New organization" : dialog === "team" ? "New team" : "Invite someone"}
        footer={
          inviteUrl ? (
            <Button onClick={() => setDialog(null)}>Done</Button>
          ) : (
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button variant="primary" type="submit" form="team-form" loading={busy}>
                {dialog === "invite" ? "Send invitation" : "Create"}
              </Button>
            </>
          )
        }
      >
        {inviteUrl ? (
          <div className="flex flex-col gap-3">
            <p>The invitation was e-mailed (if an e-mail provider is configured). You can also share this link:</p>
            <code className="break-all rounded bg-raised p-2 text-[12.5px]">{inviteUrl}</code>
            <CopyButton value={inviteUrl} />
          </div>
        ) : (
          <form id="team-form" onSubmit={submit} className="flex flex-col gap-4">
            <ErrorNote>{error}</ErrorNote>
            {dialog === "invite" ? (
              <>
                <Field label="E-mail" htmlFor="inv-email">
                  <Input id="inv-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </Field>
                <Field label="Team (optional)" htmlFor="inv-team">
                  <Select id="inv-team" value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
                    <option value="">No team</option>
                    {d?.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Role" htmlFor="inv-role">
                  <Select id="inv-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    <option value="member">Member</option>
                    {form.teamId ? <option value="manager">Team manager</option> : <option value="admin">Organization admin</option>}
                  </Select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Name" htmlFor="t-name">
                  <Input id="t-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugify(e.target.value) })} />
                </Field>
                <Field label="URL name" htmlFor="t-slug" hint={dialog === "team" ? `Public page: /team/${form.slug || "…"}` : undefined}>
                  <Input id="t-slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
                </Field>
              </>
            )}
          </form>
        )}
      </Dialog>
    </div>
  );
}
