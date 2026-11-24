import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  BarChart3,
  CalendarClock,
  CalendarDays,
  Clock,
  Contact,
  LayoutGrid,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plug,
  Settings,
  Shield,
  Signpost,
  Sun,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { cn } from "@/components/ui";
import { post } from "../lib/api";
import { getTheme, setTheme, useSession, useUser, type Theme } from "../lib/session";

const NAV = [
  { to: "/app", label: "Overview", icon: LayoutGrid, end: true },
  { to: "/app/event-types", label: "Event types", icon: CalendarClock },
  { to: "/app/bookings", label: "Bookings", icon: CalendarDays },
  { to: "/app/availability", label: "Availability", icon: Clock },
  { to: "/app/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/app/workflows", label: "Workflows", icon: Workflow },
  { to: "/app/routing-forms", label: "Routing forms", icon: Signpost },
  { to: "/app/teams", label: "Teams", icon: Users },
  { to: "/app/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/app/integrations", label: "Integrations", icon: Plug },
  { to: "/app/contacts", label: "Contacts", icon: Contact },
  { to: "/app/settings", label: "Settings", icon: Settings },
];

function ThemeSwitcher() {
  const [theme, set] = useState<Theme>(getTheme());
  const options: { v: Theme; icon: typeof Sun; label: string }[] = [
    { v: "light", icon: Sun, label: "Light" },
    { v: "dark", icon: Moon, label: "Dark" },
    { v: "system", icon: Monitor, label: "System" },
  ];
  return (
    <div className="flex rounded-[var(--radius-control)] border border-line p-0.5" role="radiogroup" aria-label="Colour theme">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={theme === o.v}
          aria-label={o.label}
          title={o.label}
          onClick={() => {
            setTheme(o.v);
            set(o.v);
          }}
          className={cn("grid h-7 flex-1 place-items-center rounded-[5px] text-muted", theme === o.v && "bg-raised text-ink")}
        >
          <o.icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

export function AppShell() {
  const user = useUser();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const items = user.isSuperAdmin ? [...NAV, { to: "/app/admin", label: "Administration", icon: Shield }] : NAV;

  const logout = async () => {
    await post("/api/auth/logout");
    refresh();
    navigate("/login");
  };

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 px-3 py-4" aria-label="Main">
      <div className="mb-4 flex items-center gap-2 px-2">
        <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
          <rect width="32" height="32" rx="8" className="fill-accent" />
          <circle cx="16" cy="16" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.6" className="text-accent-ink" />
          <path d="M16 11.5V16l3 2" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className="text-accent-ink" />
        </svg>
        <span className="font-display text-[17px] font-semibold tracking-tight">OpenMeet</span>
      </div>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={"end" in item ? item.end : false}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cn("flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-[7px] text-[13.5px] text-muted transition-colors hover:bg-raised hover:text-ink", isActive && "bg-raised text-ink font-medium")
          }
        >
          <item.icon className="size-4 shrink-0" aria-hidden />
          {item.label}
        </NavLink>
      ))}
      <div className="mt-auto flex flex-col gap-3 border-t border-line pt-4">
        <ThemeSwitcher />
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">{user.name}</p>
            <p className="truncate text-[12px] text-muted">{user.email}</p>
          </div>
          <button type="button" onClick={logout} className="rounded p-1.5 text-muted hover:bg-raised hover:text-ink" aria-label="Sign out" title="Sign out">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[236px_1fr]">
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface lg:block">{sidebar}</aside>
      <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 lg:hidden">
        <span className="font-display font-semibold">OpenMeet</span>
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="rounded p-2 text-muted">
          <Menu className="size-5" />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[260px] overflow-y-auto bg-surface animate-rise">
            <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="absolute right-3 top-3 rounded p-1.5 text-muted">
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <main key={location.pathname.split("/")[2] ?? "home"} className="mx-auto w-full max-w-[1120px] px-5 py-8 sm:px-8 lg:py-10">
        <Outlet />
      </main>
    </div>
  );
}
