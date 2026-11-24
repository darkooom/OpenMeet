import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { errorMessage, post } from "../../lib/api";
import { AuthLayout } from "./AuthLayout";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post("/api/auth/forgot-password", { email });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthLayout
      title="Reset your password"
      subtitle={sent ? "If an account exists for this address, we sent a link to choose a new password. The link is valid for one hour." : "Enter your e-mail and we will send you a reset link."}
      footer={
        <Link to="/login" className="font-medium text-accent">
          Back to sign in
        </Link>
      }
    >
      {!sent && (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <ErrorNote>{error}</ErrorNote>
          <Field label="E-mail" htmlFor="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={loading}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
