import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { errorMessage, get, post } from "../../lib/api";
import { useSession } from "../../lib/session";
import { AuthLayout } from "./AuthLayout";
import { RegisterForm } from "./Register";

export default function AcceptInvite() {
  const { token = "" } = useParams();
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const invite = useQuery({ queryKey: ["invite", token], queryFn: () => get<{ email: string; organization: string; role: string; accountExists: boolean }>(`/api/auth/invitations/${token}`) });

  if (invite.isLoading) return <AuthLayout title="Invitation"><Spinner /></AuthLayout>;
  if (invite.error || !invite.data) return <AuthLayout title="Invitation not valid" subtitle={errorMessage(invite.error)} />;
  const inv = invite.data;
  const signedInAsInvitee = me?.user && me.user.email.toLowerCase() === inv.email.toLowerCase();

  const accept = async () => {
    setLoading(true);
    try {
      await post(`/api/auth/invitations/${token}/accept`);
      refresh();
      navigate("/app/teams");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title={`Join ${inv.organization}`} subtitle={`You were invited as ${inv.role} with ${inv.email}.`}>
      <ErrorNote>{error}</ErrorNote>
      {signedInAsInvitee ? (
        <Button variant="primary" size="lg" className="w-full" loading={loading} onClick={accept}>
          Accept invitation
        </Button>
      ) : me?.user ? (
        <p className="text-muted">You are signed in as {me.user.email}. Sign out and sign in as {inv.email} to accept.</p>
      ) : inv.accountExists ? (
        <a className="font-medium text-accent" href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
          Sign in to accept
        </a>
      ) : (
        <RegisterForm invite={token} fixedEmail={inv.email} />
      )}
    </AuthLayout>
  );
}
