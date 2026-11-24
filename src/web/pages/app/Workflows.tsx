import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { Badge, Button, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner, Switch, Textarea } from "@/components/ui";
import { del, errorMessage, get, post, put } from "../../lib/api";
import type { EventTypeDto } from "../../lib/types";

type Step =
  | { type: "send_email"; to: "attendee" | "organizer" | "custom"; customTo?: string; subject: string; body: string }
  | { type: "delay"; minutes: number }
  | { type: "webhook"; url: string; secret?: string }
  | { type: "slack"; webhookUrl: string; text: string }
  | { type: "ms_teams"; webhookUrl: string; text: string }
  | { type: "http"; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: string };

interface WorkflowDto {
  id?: string;
  name: string;
  trigger: string;
  eventTypeIds: string[] | null;
  offsetMinutes: number;
  steps: Step[];
  isActive: boolean;
}

const TRIGGERS: Record<string, string> = {
  "booking.created": "When a booking is created",
  "booking.confirmed": "When a booking is confirmed",
  "booking.cancelled": "When a booking is cancelled",
  "booking.rescheduled": "When a booking is rescheduled",
  "meeting.starting": "Before a meeting starts",
  "meeting.completed": "After a meeting ends",
  "booking.no_show": "When an attendee is marked as no-show",
};

const STEP_LABELS: Record<Step["type"], string> = {
  send_email: "Send e-mail",
  delay: "Wait",
  webhook: "Send signed webhook",
  slack: "Post to Slack",
  ms_teams: "Post to Microsoft Teams",
  http: "HTTP request",
};

const NEW_STEP: Record<Step["type"], Step> = {
  send_email: { type: "send_email", to: "attendee", subject: "Your meeting: {{event.title}}", body: "Hi {{attendee.name}},\n\nlooking forward to {{booking.time}}.\n\nJoin: {{meeting.url}}" },
  delay: { type: "delay", minutes: 60 },
  webhook: { type: "webhook", url: "https://" },
  slack: { type: "slack", webhookUrl: "https://hooks.slack.com/services/…", text: "New booking: {{event.title}} with {{attendee.name}} ({{booking.time}})" },
  ms_teams: { type: "ms_teams", webhookUrl: "https://", text: "New booking: {{event.title}} with {{attendee.name}}" },
  http: { type: "http", method: "POST", url: "https://", body: '{"booking":"{{booking.id}}"}' },
};

function StepEditor({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  switch (step.type) {
    case "send_email":
      return (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select aria-label="Recipient" value={step.to} onChange={(e) => onChange({ ...step, to: e.target.value as typeof step.to })}>
              <option value="attendee">To the attendee</option>
              <option value="organizer">To the organizer</option>
              <option value="custom">To another address</option>
            </Select>
            {step.to === "custom" && <Input type="email" aria-label="E-mail address" placeholder="team@example.com" value={step.customTo ?? ""} onChange={(e) => onChange({ ...step, customTo: e.target.value })} />}
          </div>
          <Input aria-label="Subject" value={step.subject} onChange={(e) => onChange({ ...step, subject: e.target.value })} />
          <Textarea aria-label="Message" rows={5} value={step.body} onChange={(e) => onChange({ ...step, body: e.target.value })} />
        </div>
      );
    case "delay":
      return (
        <div className="flex items-center gap-2">
          <Input type="number" min={1} className="w-28" aria-label="Minutes" value={step.minutes} onChange={(e) => onChange({ ...step, minutes: Number(e.target.value) })} />
          <span className="text-muted">minutes, then continue</span>
        </div>
      );
    case "webhook":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input type="url" aria-label="URL" value={step.url} onChange={(e) => onChange({ ...step, url: e.target.value })} />
          <Input aria-label="Signing secret (optional)" placeholder="Signing secret (optional)" value={step.secret ?? ""} onChange={(e) => onChange({ ...step, secret: e.target.value })} />
        </div>
      );
    case "slack":
    case "ms_teams":
      return (
        <div className="flex flex-col gap-3">
          <Input type="url" aria-label="Incoming webhook URL" value={step.webhookUrl} onChange={(e) => onChange({ ...step, webhookUrl: e.target.value })} />
          <Textarea aria-label="Message" rows={3} value={step.text} onChange={(e) => onChange({ ...step, text: e.target.value })} />
        </div>
      );
    case "http":
      return (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
            <Select aria-label="Method" value={step.method} onChange={(e) => onChange({ ...step, method: e.target.value as typeof step.method })}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
            <Input type="url" aria-label="URL" value={step.url} onChange={(e) => onChange({ ...step, url: e.target.value })} />
          </div>
          {step.method !== "GET" && <Textarea aria-label="Body" rows={3} className="font-mono text-[12.5px]" value={step.body ?? ""} onChange={(e) => onChange({ ...step, body: e.target.value })} />}
        </div>
      );
  }
}

function WorkflowEditor({ initial, eventTypes, onClose }: { initial: WorkflowDto; eventTypes: EventTypeDto[]; onClose: (changed: boolean) => void }) {
  const [wf, setWf] = useState<WorkflowDto>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addType, setAddType] = useState<Step["type"]>("send_email");
  const timed = wf.trigger === "meeting.starting" || wf.trigger === "meeting.completed";

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { ...wf, eventTypeIds: wf.eventTypeIds && wf.eventTypeIds.length > 0 ? wf.eventTypeIds : null };
      if (wf.id) await put(`/api/automation/workflows/${wf.id}`, body);
      else await post("/api/automation/workflows", body);
      onClose(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      wide
      onClose={() => onClose(false)}
      title={wf.id ? "Edit workflow" : "New workflow"}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Save workflow
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Name" htmlFor="wf-name">
          <Input id="wf-name" value={wf.name} onChange={(e) => setWf({ ...wf, name: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Trigger" htmlFor="wf-trigger">
            <Select id="wf-trigger" value={wf.trigger} onChange={(e) => setWf({ ...wf, trigger: e.target.value })}>
              {Object.entries(TRIGGERS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          {timed && (
            <Field label={wf.trigger === "meeting.starting" ? "Minutes before start" : "Minutes after end"} htmlFor="wf-off">
              <Input id="wf-off" type="number" min={0} value={wf.offsetMinutes} onChange={(e) => setWf({ ...wf, offsetMinutes: Number(e.target.value) })} />
            </Field>
          )}
        </div>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Event types (none selected = all)</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {eventTypes.map((et) => (
              <label key={et.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-accent)]"
                  checked={wf.eventTypeIds?.includes(et.id) ?? false}
                  onChange={(e) => setWf({ ...wf, eventTypeIds: e.target.checked ? [...(wf.eventTypeIds ?? []), et.id] : (wf.eventTypeIds ?? []).filter((x) => x !== et.id) })}
                />
                {et.title}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium">Steps</p>
          {wf.steps.map((s, i) => (
            <div key={i}>
              {i > 0 && <ArrowDown className="mx-auto my-1 size-4 text-faint" aria-hidden />}
              <div className="rounded-[var(--radius-control)] border border-line p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[13px] font-medium">
                    {i + 1}. {STEP_LABELS[s.type]}
                  </span>
                  <button type="button" aria-label="Remove step" onClick={() => setWf({ ...wf, steps: wf.steps.filter((_, j) => j !== i) })} className="rounded p-1 text-faint hover:text-danger">
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <StepEditor step={s} onChange={(ns) => setWf({ ...wf, steps: wf.steps.map((x, j) => (j === i ? ns : x)) })} />
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Select aria-label="Step type" value={addType} onChange={(e) => setAddType(e.target.value as Step["type"])} className="w-56">
              {Object.entries(STEP_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Button onClick={() => setWf({ ...wf, steps: [...wf.steps, { ...NEW_STEP[addType] }] })}>
              <Plus className="size-4" /> Add step
            </Button>
          </div>
        </div>
        <p className="text-[12.5px] text-muted">
          Variables: {"{{attendee.name}} {{attendee.email}} {{organizer.name}} {{event.title}} {{booking.time}} {{booking.start_iso}} {{meeting.url}} {{booking.reschedule_url}} {{booking.cancel_url}}"}. External URLs must use HTTPS; internal addresses are blocked.
        </p>
        <Switch label="Active" checked={wf.isActive} onChange={(v) => setWf({ ...wf, isActive: v })} />
      </div>
    </Dialog>
  );
}

export default function Workflows() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["workflows"], queryFn: () => get<{ workflows: (WorkflowDto & { id: string })[] }>("/api/automation/workflows") });
  const ets = useQuery({ queryKey: ["event-types"], queryFn: () => get<{ eventTypes: EventTypeDto[] }>("/api/event-types") });
  const [editing, setEditing] = useState<WorkflowDto | null>(null);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ["wf-runs", runsFor],
    enabled: !!runsFor,
    queryFn: () => get<{ runs: { id: string; status: string; createdAt: number; log: { step?: number; type?: string; ok?: boolean; error?: string }[] }[] }>(`/api/automation/workflows/${runsFor}/runs`),
  });

  return (
    <div>
      <PageHeader
        title="Workflows"
        description="Automate reminders, follow-ups and notifications around your bookings."
        actions={
          <Button variant="primary" onClick={() => setEditing({ name: "Reminder", trigger: "meeting.starting", eventTypeIds: null, offsetMinutes: 30, steps: [{ ...NEW_STEP.send_email }], isActive: true })}>
            <Plus className="size-4" /> New workflow
          </Button>
        }
      />
      <Panel>
        {q.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : !q.data?.workflows.length ? (
          <EmptyState icon={<WorkflowIcon className="size-6" />} title="No workflows yet">
            For example: post new bookings to Slack, or send a follow-up e-mail one hour after a meeting.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.workflows.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(w)}>
                  <p className="font-medium">
                    {w.name} {!w.isActive && <Badge>Paused</Badge>}
                  </p>
                  <p className="text-[13px] text-muted">
                    {TRIGGERS[w.trigger]}
                    {w.offsetMinutes ? ` (${w.offsetMinutes} min)` : ""}: {w.steps.map((s) => STEP_LABELS[s.type]).join(", then ")}
                  </p>
                </button>
                <Button size="sm" variant="ghost" onClick={() => setRunsFor(w.id)}>
                  Runs
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Delete workflow"
                  onClick={async () => {
                    if (!confirm(`Delete "${w.name}"?`)) return;
                    await del(`/api/automation/workflows/${w.id}`);
                    void qc.invalidateQueries({ queryKey: ["workflows"] });
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {editing && (
        <WorkflowEditor
          initial={editing}
          eventTypes={ets.data?.eventTypes ?? []}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void qc.invalidateQueries({ queryKey: ["workflows"] });
          }}
        />
      )}
      <Dialog open={!!runsFor} onClose={() => setRunsFor(null)} title="Recent runs" wide>
        {runs.isLoading ? (
          <Spinner />
        ) : !runs.data?.runs.length ? (
          <p className="text-muted">This workflow has not run yet.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-[13px]">
            {runs.data.runs.map((r) => (
              <li key={r.id} className="rounded border border-line p-3">
                <p className="flex justify-between">
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                  <Badge tone={r.status === "succeeded" ? "accent" : r.status === "failed" ? "danger" : "neutral"}>{r.status}</Badge>
                </p>
                <ul className="mt-2 text-muted">
                  {r.log.map((l, i) => (
                    <li key={i}>{l.type ? `${l.type}: ${l.ok === false ? `failed (${l.error})` : "ok"}` : "done"}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}
