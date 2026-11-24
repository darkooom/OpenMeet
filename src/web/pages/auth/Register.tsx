import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { errorMessage, post } from "../../lib/api";
import { browserLocale, browserTimeZone } from "../../lib/format";
import { useSession } from "../../lib/session";
import { AuthLayout } from "./AuthLayout";
import { OAuthButtons } from "./Login";

export function RegisterForm({ invite, fixedEmail }: { invite?: string; fixedEmail?: string }) {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(fixedEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post("/api/auth/register", { name, email, password, timezone: browserTimeZone(), locale: browserLocale(), inviteToken: invite });
      refresh();
      navigate("/app");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <OAuthButtons invite={invite} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Full name" htmlFor="name">
          <Input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="E-mail" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} readOnly={!!fixedEmail} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters with letters and numbers.">
          <Input id="password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={loading}>
          Create account
        </Button>
      </form>
    </>
  );
}

export default function Register() {
  const [params] = useSearchParams();
  return (
    <AuthLayout
      title="Create your account"
      subtitle="Share a link, let people pick a time, and stop the back-and-forth."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-accent">
            Sign in
          </Link>
        </>
      }
    >
      <RegisterForm invite={params.get("invite") ?? undefined} />
    </AuthLayout>
  );
}
