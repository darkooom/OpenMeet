import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/ui";
import { get } from "./lib/api";
import { useSession } from "./lib/session";
import { AppShell } from "./layouts/AppShell";

const SetupWizard = lazy(() => import("./pages/setup/SetupWizard"));
const Login = lazy(() => import("./pages/auth/Login"));
const Register = lazy(() => import("./pages/auth/Register"));
const ForgotPassword = lazy(() => import("./pages/auth/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/auth/ResetPassword"));
const VerifyEmail = lazy(() => import("./pages/auth/VerifyEmail"));
const AcceptInvite = lazy(() => import("./pages/auth/AcceptInvite"));
const Overview = lazy(() => import("./pages/app/Overview"));
const EventTypes = lazy(() => import("./pages/app/EventTypes"));
const EventTypeEditor = lazy(() => import("./pages/app/EventTypeEditor"));
const Bookings = lazy(() => import("./pages/app/Bookings"));
const BookingDetail = lazy(() => import("./pages/app/BookingDetail"));
const Availability = lazy(() => import("./pages/app/Availability"));
const CalendarView = lazy(() => import("./pages/app/CalendarView"));
const Workflows = lazy(() => import("./pages/app/Workflows"));
const RoutingForms = lazy(() => import("./pages/app/RoutingForms"));
const Teams = lazy(() => import("./pages/app/Teams"));
const Analytics = lazy(() => import("./pages/app/Analytics"));
const Integrations = lazy(() => import("./pages/app/Integrations"));
const Contacts = lazy(() => import("./pages/app/Contacts"));
const Settings = lazy(() => import("./pages/app/Settings"));
const Admin = lazy(() => import("./pages/app/Admin"));
const PublicProfile = lazy(() => import("./pages/public/PublicProfile"));
const BookingPage = lazy(() => import("./pages/public/BookingPage"));
const ManageBooking = lazy(() => import("./pages/public/ManageBooking"));
const RoutingFormPage = lazy(() => import("./pages/public/RoutingFormPage"));
const TeamProfile = lazy(() => import("./pages/public/TeamProfile"));

function FullPageSpinner() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Spinner />
    </div>
  );
}

/** Sends a fresh instance to the setup wizard before anything else. */
function SetupGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ["setup-status"], queryFn: () => get<{ setupCompleted: boolean }>("/api/setup/status"), staleTime: 300_000 });
  useEffect(() => {
    if (status.data && !status.data.setupCompleted && !location.pathname.startsWith("/setup")) navigate("/setup", { replace: true });
  }, [status.data, location.pathname, navigate]);
  if (status.isLoading) return <FullPageSpinner />;
  return <>{children}</>;
}

function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { me, loading } = useSession();
  const location = useLocation();
  if (loading) return <FullPageSpinner />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (admin && !me.user.isSuperAdmin) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <SetupGate>
      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route path="/" element={<HomeRedirect />} />
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password/:token" element={<ResetPassword />} />
          <Route path="/verify-email/:token" element={<VerifyEmail />} />
          <Route path="/invite/:token" element={<AcceptInvite />} />

          <Route path="/u/:username" element={<PublicProfile />} />
          <Route path="/u/:username/:slug" element={<BookingPage mode="user" />} />
          <Route path="/team/:teamSlug" element={<TeamProfile />} />
          <Route path="/team/:teamSlug/:slug" element={<BookingPage mode="team" />} />
          <Route path="/book/:token" element={<BookingPage mode="link" />} />
          <Route path="/reschedule/:token" element={<ManageBooking mode="reschedule" />} />
          <Route path="/cancel/:token" element={<ManageBooking mode="cancel" />} />
          <Route path="/booking/:token" element={<ManageBooking mode="view" />} />
          <Route path="/f/:formId" element={<RoutingFormPage />} />

          <Route
            path="/app"
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Overview />} />
            <Route path="event-types" element={<EventTypes />} />
            <Route path="event-types/new" element={<EventTypeEditor />} />
            <Route path="event-types/:id" element={<EventTypeEditor />} />
            <Route path="bookings" element={<Bookings />} />
            <Route path="bookings/:id" element={<BookingDetail />} />
            <Route path="availability" element={<Availability />} />
            <Route path="calendar" element={<CalendarView />} />
            <Route path="workflows" element={<Workflows />} />
            <Route path="routing-forms" element={<RoutingForms />} />
            <Route path="teams" element={<Teams />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="settings" element={<Settings />} />
            <Route
              path="admin"
              element={
                <RequireAuth admin>
                  <Admin />
                </RequireAuth>
              }
            />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </SetupGate>
  );
}

function HomeRedirect() {
  const { me, loading } = useSession();
  if (loading) return <FullPageSpinner />;
  return <Navigate to={me?.user ? "/app" : "/login"} replace />;
}

function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl">This page does not exist</h1>
      <p className="mt-2 text-muted">Check the address, or go back to the start page.</p>
      <a className="mt-6 text-accent font-medium" href="/">
        Go to start page
      </a>
    </main>
  );
}
