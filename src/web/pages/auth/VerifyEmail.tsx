import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Spinner } from "@/components/ui";
import { errorMessage, post } from "../../lib/api";
import { useSession } from "../../lib/session";
import { AuthLayout } from "./AuthLayout";

export default function VerifyEmail() {
  const { token = "" } = useParams();
  const { refresh } = useSession();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState("");
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    post("/api/auth/verify-email", { token })
      .then(() => {
        setState("ok");
        refresh();
      })
      .catch((err) => {
        setError(errorMessage(err));
        setState("error");
      });
  }, [token, refresh]);
  return (
    <AuthLayout title={state === "ok" ? "E-mail confirmed" : state === "error" ? "Link not valid" : "Confirming…"} subtitle={state === "ok" ? "Your booking pages are now active." : state === "error" ? error : undefined}>
      {state === "loading" ? (
        <Spinner />
      ) : (
        <Link to="/app" className="font-medium text-accent">
          Open dashboard
        </Link>
      )}
    </AuthLayout>
  );
}
