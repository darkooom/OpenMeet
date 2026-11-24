import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { errorMessage, get, post } from "../../lib/api";
import { useSession } from "../../lib/session";
import { AuthLayout } from "./AuthLayout";

const OAUTH_ERRORS: Record<string, string> = {
  registration_closed: "There is no account for this e-mail address and public registration is disabled.",
  account_exists_use_password: "An account with this e-mail already exists. Sign in with your password.",
  invalid_state: "The sign-in attempt expired. Please try again.",
  access_denied: "Sign-in was cancelled.",
  not_configured: "This sign-in method is not configured.",
  token_exchange_failed: "The provider did not accept the sign-in. Please try again.",
};

export interface Providers {
  google: boolean;
  microsoft: boolean;
  registration: "open" | "invite_only" | "closed";
  productName: string;
}

export function OAuthButtons({ invite }: { invite?: string }) {
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => get<Providers>("/api/auth/providers") });
  if (!providers.data || (!providers.data.google && !providers.data.microsoft)) return null;
  const suffix = invite ? `&invite=${encodeURIComponent(invite)}` : "";
  return (
    <div className="flex flex-col gap-2">
      {providers.data.google && (
        <a href={`/auth/oauth/google/start?purpose=login${suffix}`} className="inline-flex h-10 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-line-strong bg-surface text-sm font-medium hover:bg-raised">
          Continue with Google
        </a>
      )}
      {providers.data.microsoft && (
        <a href={`/auth/oauth/microsoft/start?purpose=login${suffix}`} className="inline-flex h-10 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-line-strong bg-surface text-sm font-medium hover:bg-raised">
          Continue with Microsoft
        </a>
      )}
      <div className="my-3 flex items-center gap-3 text-[12px] text-faint">
        <span className="h-px flex-1 bg-line" />
        or with e-mail
        <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("error") ? (OAUTH_ERRORS[params.get("error")!] ?? "Sign-in failed.") : null);
  const [loading, setLoading] = useState(false);
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => get<Providers>("/api/auth/providers") });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post("/api/auth/login", { email, password });
      refresh();
      const next = params.get("next");
      navigate(next && (next.startsWith("/app") || next.startsWith("/invite/")) ? next : "/app");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle={providers.data?.productName && providers.data.productName !== "OpenMeet" ? providers.data.productName : "Welcome back."}
      footer={
        providers.data?.registration === "open" ? (
          <>
            New here?{" "}
            <Link to="/signup" className="font-medium text-accent">
              Create an account
            </Link>
          </>
        ) : (
          "Accounts on this instance are created by invitation."
        )
      }
    >
      <OAuthButtons />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="E-mail" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={loading}>
          Sign in
        </Button>
        <Link to="/forgot-password" className="text-[13px] text-muted hover:text-ink">
          Forgot your password?
        </Link>
      </form>
    </AuthLayout>
  );
}
