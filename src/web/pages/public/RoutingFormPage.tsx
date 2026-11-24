import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, ErrorNote, Field, Input, Select, Spinner, Textarea } from "@/components/ui";
import { errorMessage, get, post } from "../../lib/api";
import { PublicFrame, useEmbed } from "./BookingPage";

interface FormField {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "multi" | "email";
  required: boolean;
  options?: string[];
}

export default function RoutingFormPage() {
  const { formId = "" } = useParams();
  const embed = useEmbed();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["form", formId], queryFn: () => get<{ form: { id: string; name: string; description: string | null; fields: FormField[] } }>(`/api/public/forms/${formId}`), retry: false });
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await post<{ target: { type: string; path?: string; url?: string; message?: string }; prefill: Record<string, string> }>(`/api/public/forms/${formId}/submit`, { answers });
      const t = res.target;
      if (t.type === "event_type" && t.path) {
        const p = new URLSearchParams(res.prefill);
        if (embed) p.set("embed", "1");
        p.set("source", "routing_form");
        navigate(`${t.path}?${p.toString()}`);
      } else if (t.type === "url" && t.url) {
        window.location.href = t.url;
      } else setMessage(t.message ?? "Thank you!");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PublicFrame embed={embed}>
      <div className="mx-auto max-w-[560px] rounded-[16px] border border-line bg-surface p-6 md:p-10">
        {q.isLoading ? (
          <Spinner />
        ) : !q.data ? (
          <h1 className="text-2xl">This form does not exist</h1>
        ) : message ? (
          <>
            <h1 className="text-[26px]">{q.data.form.name}</h1>
            <p className="mt-3 whitespace-pre-line text-muted">{message}</p>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <h1 className="text-[26px] leading-tight">{q.data.form.name}</h1>
              {q.data.form.description && <p className="mt-2 text-muted">{q.data.form.description}</p>}
            </div>
            <ErrorNote>{error}</ErrorNote>
            {q.data.form.fields.map((f) => {
              const id = `f-${f.id}`;
              const v = answers[f.id];
              const set = (val: string | string[]) => setAnswers({ ...answers, [f.id]: val });
              if (f.type === "select")
                return (
                  <Field key={f.id} label={f.label} htmlFor={id}>
                    <Select id={id} required={f.required} value={(v as string) ?? ""} onChange={(e) => set(e.target.value)}>
                      <option value="">Select…</option>
                      {f.options?.map((o) => <option key={o}>{o}</option>)}
                    </Select>
                  </Field>
                );
              if (f.type === "multi")
                return (
                  <fieldset key={f.id} className="flex flex-col gap-1.5">
                    <legend className="mb-1 text-[13px] font-medium">{f.label}</legend>
                    {f.options?.map((o) => {
                      const checked = Array.isArray(v) && v.includes(o);
                      return (
                        <label key={o} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={checked} onChange={() => set(checked ? (v as string[]).filter((x) => x !== o) : [...((v as string[]) ?? []), o])} className="size-4 accent-[var(--color-accent)]" />
                          {o}
                        </label>
                      );
                    })}
                  </fieldset>
                );
              if (f.type === "textarea") return <Field key={f.id} label={f.label} htmlFor={id}><Textarea id={id} required={f.required} value={(v as string) ?? ""} onChange={(e) => set(e.target.value)} /></Field>;
              return (
                <Field key={f.id} label={f.label} htmlFor={id}>
                  <Input id={id} type={f.type === "email" ? "email" : "text"} required={f.required} value={(v as string) ?? ""} onChange={(e) => set(e.target.value)} />
                </Field>
              );
            })}
            <Button type="submit" variant="primary" size="lg" loading={loading}>
              Continue
            </Button>
          </form>
        )}
      </div>
    </PublicFrame>
  );
}
