import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get } from "./api";

export interface Me {
  id: string;
  email: string;
  name: string;
  username: string;
  timezone: string;
  locale: string;
  isSuperAdmin: boolean;
  emailVerified: boolean;
  bio: string | null;
  timeFormat: string;
  brandColor: string | null;
  hasPassword: boolean;
}
export interface MeResponse {
  user: Me | null;
  organizations?: { id: string; name: string; slug: string; role: "owner" | "admin" | "member" }[];
}

const Ctx = createContext<{ me: MeResponse | undefined; loading: boolean; refresh: () => void }>({ me: undefined, loading: true, refresh: () => undefined });

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["me"], queryFn: () => get<MeResponse>("/api/auth/me"), staleTime: 60_000 });
  return <Ctx.Provider value={{ me: q.data, loading: q.isLoading, refresh: () => void qc.invalidateQueries({ queryKey: ["me"] }) }}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}

export function useUser(): Me {
  const { me } = useSession();
  if (!me?.user) throw new Error("useUser outside of authenticated area");
  return me.user;
}

export type Theme = "light" | "dark" | "system";
export function getTheme(): Theme {
  return (localStorage.getItem("om-theme") as Theme | null) ?? "system";
}
export function setTheme(t: Theme) {
  localStorage.setItem("om-theme", t);
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
