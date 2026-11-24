import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { errorMessage, post } from "../../lib/api";
import { AuthLayout } from "./AuthLayout";

export default function ResetPassword() {
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post("/api/auth/reset-password", { token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthLayout title={done ? "Password changed" : "Choose a new password"} subtitle={done ? "All other sessions were signed out." : undefined}>
      {done ? (
        <Link to="/login" className="font-medium text-accent">
          Sign in with your new password
        </Link>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <ErrorNote>{error}</ErrorNote>
          <Field label="New password" htmlFor="pw" hint="At least 10 characters with letters and numbers.">
            <Input id="pw" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={loading}>
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
