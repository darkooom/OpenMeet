import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button, ErrorNote, Field, Input, Select, Spinner, cn } from "@/components/ui";
import { errorMessage, get, post } from "../../lib/api";
import { browserLocale, browserTimeZone, TIME_ZONES } from "../../lib/format";
import { useSession } from "../../lib/session";
import { Logo } from "../auth/AuthLayout";

interface Status {
  setupCompleted: boolean;
  setupTokenConfigured: boolean;
  encryptionKeyConfigured: boolean;
  detectedBaseUrl: string;
}

const STEPS = ["Welcome", "Administrator", "Instance", "E-mail", "Calendars", "Organization", "First event type", "Done"];

function slugify(s: string) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default function SetupWizard() {
  const qc = useQueryClient();
  const { refresh } = useSession();
  const status = useQuery({ queryKey: ["setup-status-wizard"], queryFn: () => get<Status>("/api/setup/status") });
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState("");
  const [admin, setAdmin] = useState({ name: "", email: "", username: "", password: "" });
  const [instance, setInstance] = useState({ productName: "OpenMeet", defaultLocale: browserLocale(), defaultTimezone: browserTimeZone(), publicBaseUrl: "", registration: "invite_only" as "open" | "invite_only" | "closed" });
  const [email, setEmail] = useState({ enabled: false, provider: "resend" as "resend" | "brevo" | "postmark", apiKey: "", fromEmail: "", fromName: "OpenMeet" });
  const [google, setGoogle] = useState({ clientId: "", clientSecret: "" });
  const [microsoft, setMicrosoft] = useState({ clientId: "", clientSecret: "", tenant: "common" });
  const [org, setOrg] = useState({ name: "", slug: "" });
  const [eventType, setEventType] = useState({ title: "30 minute meeting", slug: "30min", duration: 30 });
  const [result, setResult] = useState<{ bookingUrl: string } | null>(null);

  useEffect(() => {
    if (status.data && !instance.publicBaseUrl) setInstance((i) => ({ ...i, publicBaseUrl: status.data!.detectedBaseUrl }));
  }, [status.data, instance.publicBaseUrl]);

  if (status.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  if (status.data?.setupCompleted && !result) {
    return (
      <Shell step={-1}>
        <h1 className="text-3xl">This instance is already set up</h1>
        <p className="mt-2 text-muted">The setup wizard is locked permanently after the first run.</p>
        <a href="/login" className="mt-6 inline-block font-medium text-accent">
          Go to sign in
        </a>
      </Shell>
    );
  }
  const missingSecrets = status.data && (!status.data.setupTokenConfigured || !status.data.encryptionKeyConfigured);

  const next = () => {
    setError(null);
    setStep((s) => s + 1);
  };
  const back = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  const verifyToken = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post("/api/setup/verify", { token });
      next();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const complete = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await post<{ bookingUrl: string }>("/api/setup/complete", {
        token,
        admin,
        instance: { ...instance, publicBaseUrl: instance.publicBaseUrl || null },
        email: email.enabled ? { provider: email.provider, apiKey: email.apiKey, fromEmail: email.fromEmail, fromName: email.fromName } : null,
        google: google.clientId ? google : null,
        microsoft: microsoft.clientId ? microsoft : null,
        organization: org,
        eventType,
      });
      setResult(res);
      setStep(7);
      refresh();
      void qc.invalidateQueries({ queryKey: ["setup-status"] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const callback = (p: string) => `${(instance.publicBaseUrl || status.data?.detectedBaseUrl || "").replace(/\/+$/, "")}/auth/oauth/${p}/callback`;

  return (
    <Shell step={step}>
      {step === 0 && (
        <form onSubmit={verifyToken} className="flex flex-col gap-5">
          <div>
            <h1 className="text-[30px] leading-tight">Welcome to OpenMeet</h1>
            <p className="mt-2 max-w-[56ch] text-muted">
              Let's set up your scheduling instance. To prove that you deployed it, enter the setup token you defined as the <code className="rounded bg-raised px-1">SETUP_TOKEN</code> secret during installation.
            </p>
          </div>
          {missingSecrets && (
            <ErrorNote>
              {!status.data?.setupTokenConfigured && "The SETUP_TOKEN secret is missing or shorter than 32 characters. "}
              {!status.data?.encryptionKeyConfigured && "The ENCRYPTION_KEY secret is missing or shorter than 32 characters. "}
              Add them in the Cloudflare dashboard (Worker → Settings → Variables and Secrets) and reload this page.
            </ErrorNote>
          )}
          <ErrorNote>{error}</ErrorNote>
          <Field label="Setup token" htmlFor="token" hint="The token is sent only to your instance and never stored in the browser.">
            <Input id="token" type="password" autoComplete="off" required value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" variant="primary" size="lg" loading={loading} disabled={!!missingSecrets}>
              Continue
            </Button>
          </div>
        </form>
      )}

      {step === 1 && (
        <StepForm title="Create the administrator" description="This account manages the whole instance." onBack={back} onSubmit={next}>
          <Field label="Full name" htmlFor="a-name">
            <Input id="a-name" required value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} />
          </Field>
          <Field label="E-mail" htmlFor="a-email">
            <Input id="a-email" type="email" required value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value, username: admin.username || slugify(e.target.value.split("@")[0] ?? "") })} />
          </Field>
          <Field label="Username" htmlFor="a-user" hint={`Your booking page: /u/${admin.username || "name"}`}>
            <Input id="a-user" required pattern="[a-z0-9]+([\-_.][a-z0-9]+)*" value={admin.username} onChange={(e) => setAdmin({ ...admin, username: e.target.value.toLowerCase() })} />
          </Field>
          <Field label="Password" htmlFor="a-pw" hint="At least 10 characters with letters and numbers.">
            <Input id="a-pw" type="password" autoComplete="new-password" minLength={10} required value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} />
          </Field>
        </StepForm>
      )}

      {step === 2 && (
        <StepForm title="Configure the instance" onBack={back} onSubmit={next}>
          <Field label="Product name" htmlFor="i-name" hint="Shown in e-mails and on the sign-in page.">
            <Input id="i-name" required value={instance.productName} onChange={(e) => setInstance({ ...instance, productName: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Default language" htmlFor="i-lang">
              <Select id="i-lang" value={instance.defaultLocale} onChange={(e) => setInstance({ ...instance, defaultLocale: e.target.value as "en" | "de" })}>
                <option value="en">English</option>
                <option value="de">Deutsch</option>
              </Select>
            </Field>
            <Field label="Default time zone" htmlFor="i-tz">
              <Select id="i-tz" value={instance.defaultTimezone} onChange={(e) => setInstance({ ...instance, defaultTimezone: e.target.value })}>
                {TIME_ZONES.map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Public URL" htmlFor="i-url" hint="Used in e-mails and OAuth callbacks. Keep the workers.dev address until your custom domain is connected.">
            <Input id="i-url" type="url" value={instance.publicBaseUrl} onChange={(e) => setInstance({ ...instance, publicBaseUrl: e.target.value })} />
          </Field>
          <Field label="Who can sign up?" htmlFor="i-reg">
            <Select id="i-reg" value={instance.registration} onChange={(e) => setInstance({ ...instance, registration: e.target.value as typeof instance.registration })}>
              <option value="invite_only">Only invited people</option>
              <option value="open">Anyone with the link</option>
              <option value="closed">Nobody (administrators create accounts)</option>
            </Select>
          </Field>
        </StepForm>
      )}

      {step === 3 && (
        <StepForm title="E-mail delivery" description="Optional. Without a provider OpenMeet works, but confirmations, reminders and invitations are not sent." onBack={back} onSubmit={next} skip={() => { setEmail({ ...email, enabled: false }); next(); }}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={email.enabled} onChange={(e) => setEmail({ ...email, enabled: e.target.checked })} className="size-4 accent-[var(--color-accent)]" />
            Configure an e-mail provider now
          </label>
          {email.enabled && (
            <>
              <Field label="Provider" htmlFor="e-p">
                <Select id="e-p" value={email.provider} onChange={(e) => setEmail({ ...email, provider: e.target.value as typeof email.provider })}>
                  <option value="resend">Resend</option>
                  <option value="brevo">Brevo</option>
                  <option value="postmark">Postmark</option>
                </Select>
              </Field>
              <Field label="API key" htmlFor="e-k" hint="Stored encrypted. It is never shown again.">
                <Input id="e-k" type="password" autoComplete="off" required value={email.apiKey} onChange={(e) => setEmail({ ...email, apiKey: e.target.value })} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Sender address" htmlFor="e-f" hint="Must be verified at your provider.">
                  <Input id="e-f" type="email" required value={email.fromEmail} onChange={(e) => setEmail({ ...email, fromEmail: e.target.value })} />
                </Field>
                <Field label="Sender name" htmlFor="e-n">
                  <Input id="e-n" required value={email.fromName} onChange={(e) => setEmail({ ...email, fromName: e.target.value })} />
                </Field>
              </div>
            </>
          )}
        </StepForm>
      )}

      {step === 4 && (
        <StepForm title="Calendar integrations" description="Optional. Add OAuth apps to let users sign in with Google or Microsoft and connect their calendars. You can do this later in Administration." onBack={back} onSubmit={next} skip={() => { setGoogle({ clientId: "", clientSecret: "" }); setMicrosoft({ clientId: "", clientSecret: "", tenant: "common" }); next(); }}>
          <fieldset className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-line p-4">
            <legend className="px-1 text-sm font-medium">Google</legend>
            <p className="text-[12.5px] text-muted">
              Redirect URI: <code className="break-all">{callback("google")}</code>
            </p>
            <Input aria-label="Google client ID" placeholder="Client ID" value={google.clientId} onChange={(e) => setGoogle({ ...google, clientId: e.target.value })} />
            <Input aria-label="Google client secret" placeholder="Client secret" type="password" value={google.clientSecret} onChange={(e) => setGoogle({ ...google, clientSecret: e.target.value })} />
          </fieldset>
          <fieldset className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-line p-4">
            <legend className="px-1 text-sm font-medium">Microsoft 365 / Outlook</legend>
            <p className="text-[12.5px] text-muted">
              Redirect URI: <code className="break-all">{callback("microsoft")}</code>
            </p>
            <Input aria-label="Microsoft client ID" placeholder="Application (client) ID" value={microsoft.clientId} onChange={(e) => setMicrosoft({ ...microsoft, clientId: e.target.value })} />
            <Input aria-label="Microsoft client secret" placeholder="Client secret" type="password" value={microsoft.clientSecret} onChange={(e) => setMicrosoft({ ...microsoft, clientSecret: e.target.value })} />
            <Input aria-label="Microsoft tenant" placeholder="Tenant (common)" value={microsoft.tenant} onChange={(e) => setMicrosoft({ ...microsoft, tenant: e.target.value })} />
          </fieldset>
        </StepForm>
      )}

      {step === 5 && (
        <StepForm title="Create your organization" description="Organizations group people, teams and shared event types." onBack={back} onSubmit={next}>
          <Field label="Organization name" htmlFor="o-name">
            <Input id="o-name" required value={org.name} onChange={(e) => setOrg({ name: e.target.value, slug: org.slug && org.slug !== slugify(org.name) ? org.slug : slugify(e.target.value) })} />
          </Field>
          <Field label="URL name" htmlFor="o-slug">
            <Input id="o-slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={org.slug} onChange={(e) => setOrg({ ...org, slug: e.target.value.toLowerCase() })} />
          </Field>
        </StepForm>
      )}

      {step === 6 && (
        <form onSubmit={complete} className="flex flex-col gap-5">
          <div>
            <h1 className="text-[28px] leading-tight">Your first event type</h1>
            <p className="mt-2 text-muted">People will book this meeting on your public page. You can change everything later.</p>
          </div>
          <ErrorNote>{error}</ErrorNote>
          <Field label="Title" htmlFor="et-title">
            <Input id="et-title" required value={eventType.title} onChange={(e) => setEventType({ ...eventType, title: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="URL" htmlFor="et-slug">
              <Input id="et-slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={eventType.slug} onChange={(e) => setEventType({ ...eventType, slug: e.target.value.toLowerCase() })} />
            </Field>
            <Field label="Duration" htmlFor="et-dur">
              <Select id="et-dur" value={eventType.duration} onChange={(e) => setEventType({ ...eventType, duration: Number(e.target.value) })}>
                {[15, 20, 30, 45, 60, 90].map((d) => (
                  <option key={d} value={d}>
                    {d} minutes
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex gap-2">
            <Button onClick={back}>Back</Button>
            <Button type="submit" variant="primary" loading={loading}>
              Finish setup
            </Button>
          </div>
        </form>
      )}

      {step === 7 && result && (
        <div className="flex flex-col gap-4">
          <h1 className="text-[30px] leading-tight">You're ready</h1>
          <p className="text-muted">The setup wizard is now locked. Your booking page is live – share it, or fine-tune your availability first.</p>
          <div className="flex flex-wrap gap-2">
            <a href={result.bookingUrl} className="inline-flex h-11 items-center rounded-[var(--radius-control)] bg-accent px-5 font-medium text-accent-ink">
              Open my booking page
            </a>
            <a href="/app" className="inline-flex h-11 items-center rounded-[var(--radius-control)] border border-line-strong px-5 font-medium">
              Go to dashboard
            </a>
          </div>
        </div>
      )}
    </Shell>
  );
}

function StepForm({ title, description, children, onBack, onSubmit, skip }: { title: string; description?: string; children: ReactNode; onBack: () => void; onSubmit: () => void; skip?: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-5"
    >
      <div>
        <h1 className="text-[28px] leading-tight">{title}</h1>
        {description && <p className="mt-2 max-w-[56ch] text-muted">{description}</p>}
      </div>
      {children}
      <div className="flex gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button type="submit" variant="primary">
          Continue
        </Button>
        {skip && (
          <Button variant="ghost" onClick={skip}>
            Skip for now
          </Button>
        )}
      </div>
    </form>
  );
}

function Shell({ step, children }: { step: number; children: ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[280px_1fr]">
      <aside className="border-b border-line bg-surface px-6 py-6 md:border-b-0 md:border-r md:py-10">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="font-display text-lg font-semibold">OpenMeet setup</span>
        </div>
        {step >= 0 && (
          <ol className="mt-8 hidden flex-col gap-1 md:flex" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li key={s} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5 text-[13.5px]", i === step ? "bg-raised font-medium text-ink" : i < step ? "text-ink" : "text-faint")}>
                <span className={cn("grid size-5 place-items-center rounded-full border text-[11px] tabular", i < step ? "border-accent bg-accent text-accent-ink" : i === step ? "border-ink" : "border-line-strong")}>
                  {i < step ? <Check className="size-3" /> : i + 1}
                </span>
                {s}
              </li>
            ))}
          </ol>
        )}
        {step >= 0 && <p className="mt-3 text-[13px] text-muted md:hidden">Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>}
      </aside>
      <main className="flex items-start justify-center px-6 py-10 md:py-20">
        <div className="w-full max-w-[540px] animate-rise" key={step}>
          {children}
        </div>
      </main>
    </div>
  );
}
