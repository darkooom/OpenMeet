import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus, Signpost, Trash2 } from "lucide-react";
import { Button, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner, Switch, Textarea } from "@/components/ui";
import { del, errorMessage, get, post, put } from "../../lib/api";
import type { EventTypeDto } from "../../lib/types";
import { CopyButton } from "./Overview";

interface FieldDef {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "multi" | "email";
  required: boolean;
  options?: string[];
}
type Target = { type: "event_type"; eventTypeId: string } | { type: "url"; url: string } | { type: "message"; message: string };
interface Rule {
  id: string;
  match: "all" | "any";
  conditions: { fieldId: string; op: string; value?: string }[];
  target: Target;
}
interface FormDto {
  id?: string;
  name: string;
  description: string | null;
  fields: FieldDef[];
  rules: Rule[];
  fallback: Target;
  isActive: boolean;
}

function TargetEditor({ target, onChange, eventTypes }: { target: Target; onChange: (t: Target) => void; eventTypes: EventTypeDto[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[170px_1fr]">
      <Select
        aria-label="Destination type"
        value={target.type}
        onChange={(e) => {
          const t = e.target.value;
          onChange(t === "event_type" ? { type: "event_type", eventTypeId: eventTypes[0]?.id ?? "" } : t === "url" ? { type: "url", url: "https://" } : { type: "message", message: "Thank you!" });
        }}
      >
        <option value="event_type">Book an event type</option>
        <option value="url">Open a URL</option>
        <option value="message">Show a message</option>
      </Select>
      {target.type === "event_type" ? (
        <Select aria-label="Event type" value={target.eventTypeId} onChange={(e) => onChange({ type: "event_type", eventTypeId: e.target.value })}>
          {eventTypes.map((et) => (
            <option key={et.id} value={et.id}>
              {et.title}
              {et.team ? ` (${et.team.name})` : ""}
            </option>
          ))}
        </Select>
      ) : target.type === "url" ? (
        <Input aria-label="URL" type="url" value={target.url} onChange={(e) => onChange({ type: "url", url: e.target.value })} />
      ) : (
        <Input aria-label="Message" value={target.message} onChange={(e) => onChange({ type: "message", message: e.target.value })} />
      )}
    </div>
  );
}

function FormEditor({ initial, eventTypes, onClose }: { initial: FormDto; eventTypes: EventTypeDto[]; onClose: (changed: boolean) => void }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (f.id) await put(`/api/automation/routing-forms/${f.id}`, f);
      else await post("/api/automation/routing-forms", f);
      onClose(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const choiceFields = f.fields.filter((x) => x.label);
  return (
    <Dialog
      open
      wide
      onClose={() => onClose(false)}
      title={f.id ? "Edit routing form" : "New routing form"}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Save form
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Name" htmlFor="rf-name">
          <Input id="rf-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Intro text" htmlFor="rf-desc">
          <Textarea id="rf-desc" rows={2} value={f.description ?? ""} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div>
          <p className="mb-2 text-[13px] font-medium">Questions</p>
          <div className="flex flex-col gap-2">
            {f.fields.map((fd, i) => (
              <div key={fd.id} className="grid gap-2 rounded border border-line p-2.5 sm:grid-cols-[1fr_140px_auto]">
                <Input aria-label="Question" placeholder="Question" value={fd.label} onChange={(e) => setF({ ...f, fields: f.fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <Select aria-label="Type" value={fd.type} onChange={(e) => setF({ ...f, fields: f.fields.map((x, j) => (j === i ? { ...x, type: e.target.value as FieldDef["type"] } : x)) })}>
                  <option value="select">Dropdown</option>
                  <option value="multi">Multiple choice</option>
                  <option value="text">Short text</option>
                  <option value="textarea">Long text</option>
                  <option value="email">E-mail</option>
                </Select>
                <button type="button" aria-label="Remove question" onClick={() => setF({ ...f, fields: f.fields.filter((_, j) => j !== i) })} className="rounded p-1.5 text-faint hover:text-danger">
                  <Trash2 className="size-4" />
                </button>
                {(fd.type === "select" || fd.type === "multi") && (
                  <Input className="sm:col-span-3" aria-label="Options" placeholder="Options, comma separated" value={(fd.options ?? []).join(", ")} onChange={(e) => setF({ ...f, fields: f.fields.map((x, j) => (j === i ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x)) })} />
                )}
                <label className="flex items-center gap-2 text-[13px] sm:col-span-3">
                  <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={fd.required} onChange={(e) => setF({ ...f, fields: f.fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} /> Required
                </label>
              </div>
            ))}
            <div>
              <Button size="sm" onClick={() => setF({ ...f, fields: [...f.fields, { id: `f${Date.now().toString(36)}`, label: "", type: "select", required: true, options: [] }] })}>
                <Plus className="size-3.5" /> Add question
              </Button>
            </div>
          </div>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-medium">Rules (first match wins)</p>
          <div className="flex flex-col gap-2">
            {f.rules.map((r, i) => {
              const c = r.conditions[0]!;
              const field = f.fields.find((x) => x.id === c.fieldId);
              return (
                <div key={r.id} className="flex flex-col gap-2 rounded border border-line p-2.5">
                  <div className="grid gap-2 sm:grid-cols-[1fr_130px_1fr_auto]">
                    <Select aria-label="If question" value={c.fieldId} onChange={(e) => setF({ ...f, rules: f.rules.map((x, j) => (j === i ? { ...x, conditions: [{ ...c, fieldId: e.target.value }] } : x)) })}>
                      {choiceFields.map((x) => (
                        <option key={x.id} value={x.id}>
                          If “{x.label}”
                        </option>
                      ))}
                    </Select>
                    <Select aria-label="Operator" value={c.op} onChange={(e) => setF({ ...f, rules: f.rules.map((x, j) => (j === i ? { ...x, conditions: [{ ...c, op: e.target.value }] } : x)) })}>
                      <option value="equals">is</option>
                      <option value="not_equals">is not</option>
                      <option value="contains">contains</option>
                      <option value="not_empty">is answered</option>
                    </Select>
                    {field?.options && field.options.length > 0 ? (
                      <Select aria-label="Value" value={c.value ?? ""} onChange={(e) => setF({ ...f, rules: f.rules.map((x, j) => (j === i ? { ...x, conditions: [{ ...c, value: e.target.value }] } : x)) })}>
                        <option value="">Select…</option>
                        {field.options.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </Select>
                    ) : (
                      <Input aria-label="Value" value={c.value ?? ""} onChange={(e) => setF({ ...f, rules: f.rules.map((x, j) => (j === i ? { ...x, conditions: [{ ...c, value: e.target.value }] } : x)) })} />
                    )}
                    <button type="button" aria-label="Remove rule" onClick={() => setF({ ...f, rules: f.rules.filter((_, j) => j !== i) })} className="rounded p-1.5 text-faint hover:text-danger">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  <TargetEditor target={r.target} eventTypes={eventTypes} onChange={(t) => setF({ ...f, rules: f.rules.map((x, j) => (j === i ? { ...x, target: t } : x)) })} />
                </div>
              );
            })}
            <div>
              <Button
                size="sm"
                disabled={choiceFields.length === 0}
                onClick={() => setF({ ...f, rules: [...f.rules, { id: `r${Date.now().toString(36)}`, match: "all", conditions: [{ fieldId: choiceFields[0]!.id, op: "equals", value: "" }], target: { type: "event_type", eventTypeId: eventTypes[0]?.id ?? "" } }] })}
              >
                <Plus className="size-3.5" /> Add rule
              </Button>
            </div>
          </div>
        </div>
        <Field label="Otherwise" htmlFor="">
          <TargetEditor target={f.fallback} eventTypes={eventTypes} onChange={(t) => setF({ ...f, fallback: t })} />
        </Field>
        <Switch label="Active" checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
      </div>
    </Dialog>
  );
}

export default function RoutingForms() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["routing-forms"], queryFn: () => get<{ forms: (FormDto & { id: string })[] }>("/api/automation/routing-forms") });
  const ets = useQuery({ queryKey: ["event-types"], queryFn: () => get<{ eventTypes: EventTypeDto[] }>("/api/event-types") });
  const [editing, setEditing] = useState<FormDto | null>(null);
  const eventTypes = ets.data?.eventTypes ?? [];
  const origin = window.location.origin;

  return (
    <div>
      <PageHeader
        title="Routing forms"
        description="Ask a few questions first, then send people to the right meeting."
        actions={
          <Button
            variant="primary"
            disabled={eventTypes.length === 0}
            onClick={() =>
              setEditing({
                name: "How can we help?",
                description: null,
                fields: [{ id: "topic", label: "What is it about?", type: "select", required: true, options: ["Technical support", "Setup", "Sales", "Billing"] }],
                rules: [],
                fallback: { type: "event_type", eventTypeId: eventTypes[0]?.id ?? "" },
                isActive: true,
              })
            }
          >
            <Plus className="size-4" /> New form
          </Button>
        }
      />
      <Panel>
        {q.isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : !q.data?.forms.length ? (
          <EmptyState icon={<Signpost className="size-6" />} title="No routing forms">
            {eventTypes.length === 0 ? "Create an event type first – forms route visitors to event types." : "Route visitors to support, sales or billing based on their answers."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.forms.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(f)}>
                  <p className="font-medium">{f.name}</p>
                  <p className="text-[13px] text-muted">
                    {f.fields.length} question(s), {f.rules.length} rule(s)
                  </p>
                </button>
                <CopyButton value={`${origin}/f/${f.id}`} label="Copy link" />
                <CopyButton value={`<iframe src="${origin}/f/${f.id}?embed=1" style="width:100%;min-height:520px;border:0"></iframe>`} label="Copy embed" />
                <a href={`/f/${f.id}`} target="_blank" rel="noreferrer" aria-label="Open form" className="rounded p-1.5 text-muted hover:text-ink">
                  <ExternalLink className="size-4" />
                </a>
                <button
                  type="button"
                  aria-label="Delete form"
                  onClick={async () => {
                    if (!confirm(`Delete "${f.name}"?`)) return;
                    await del(`/api/automation/routing-forms/${f.id}`);
                    void qc.invalidateQueries({ queryKey: ["routing-forms"] });
                  }}
                  className="rounded p-1.5 text-muted hover:text-danger"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {editing && (
        <FormEditor
          initial={editing}
          eventTypes={eventTypes}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void qc.invalidateQueries({ queryKey: ["routing-forms"] });
          }}
        />
      )}
    </div>
  );
}
