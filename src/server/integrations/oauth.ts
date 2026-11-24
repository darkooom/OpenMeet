/**
 * OAuth 2.0 authorization-code flow with PKCE (S256) and server-side state.
 * Used for "Sign in with Google/Microsoft" and for calendar / Zoom connections.
 */
import { eq } from "drizzle-orm";
import { oauthStates } from "../../database/schema";
import type { AppVariables, Env } from "../env";
import { badRequest } from "../lib/errors";
import { newToken } from "../lib/ids";
import { pkceChallenge } from "../security/crypto";
import { getCredentials } from "../services/settings";

type Db = AppVariables["db"];

export type OAuthProvider = "google" | "microsoft" | "zoom";
export type OAuthPurpose = "login" | "calendar" | "zoom";

export interface ProviderConfig {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

export const SCOPES: Record<string, string[]> = {
  "google:login": ["openid", "email", "profile"],
  // Minimal scopes: list calendars, free/busy, manage events created by OpenMeet.
  "google:calendar": [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/calendar.events",
  ],
  "microsoft:login": ["openid", "email", "profile"],
  "microsoft:calendar": ["openid", "email", "offline_access", "User.Read", "Calendars.ReadWrite"],
  "zoom:zoom": ["meeting:write:meeting", "user:read:user"],
};

export async function providerConfig(db: Db, env: Env, provider: OAuthProvider): Promise<ProviderConfig | null> {
  if (provider === "google") {
    const c = await getCredentials(db, env, "google");
    return c ? { authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", ...c } : null;
  }
  if (provider === "microsoft") {
    const c = await getCredentials(db, env, "microsoft");
    if (!c) return null;
    const tenant = encodeURIComponent(c.tenant || "common");
    return {
      authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      clientId: c.clientId,
      clientSecret: c.clientSecret,
    };
  }
  const c = await getCredentials(db, env, "zoom");
  return c ? { authUrl: "https://zoom.us/oauth/authorize", tokenUrl: "https://zoom.us/oauth/token", ...c } : null;
}

export function callbackUrl(baseUrl: string, provider: OAuthProvider): string {
  return `${baseUrl}/auth/oauth/${provider}/callback`;
}

export interface StoredState {
  provider: OAuthProvider;
  purpose: OAuthPurpose;
  verifier: string;
  userId?: string;
  inviteToken?: string;
  returnTo?: string;
}

export async function startAuthorization(db: Db, env: Env, baseUrl: string, state: Omit<StoredState, "verifier">): Promise<string> {
  const cfg = await providerConfig(db, env, state.provider);
  if (!cfg) throw badRequest(`${state.provider} is not configured on this instance`);
  const verifier = newToken(48);
  const stateId = newToken(24);
  await db.insert(oauthStates).values({ state: stateId, data: JSON.stringify({ ...state, verifier }), expiresAt: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl(baseUrl, state.provider),
    response_type: "code",
    state: stateId,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  const scopes = SCOPES[`${state.provider}:${state.purpose}`];
  if (scopes) params.set("scope", scopes.join(" "));
  if (state.provider === "google") {
    params.set("include_granted_scopes", "true");
    if (state.purpose === "calendar") {
      params.set("access_type", "offline");
      params.set("prompt", "consent");
    } else params.set("prompt", "select_account");
  }
  if (state.provider === "microsoft") params.set("response_mode", "query");
  return `${cfg.authUrl}?${params.toString()}`;
}

/** Atomically consumes the state (single use, 10 min TTL). */
export async function consumeState(db: Db, stateId: string): Promise<StoredState | null> {
  if (!stateId || stateId.length > 100) return null;
  const row = await db.delete(oauthStates).where(eq(oauthStates.state, stateId)).returning().get();
  if (!row || row.expiresAt < Date.now()) return null;
  return JSON.parse(row.data) as StoredState;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
}

export async function exchangeCode(cfg: ProviderConfig, provider: OAuthProvider, code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (provider === "zoom") headers.authorization = `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`;
  else {
    body.set("client_id", cfg.clientId);
    body.set("client_secret", cfg.clientSecret);
  }
  const res = await fetch(cfg.tokenUrl, { method: "POST", headers, body });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Token exchange failed: ${json.error ?? res.status}`);
  return json;
}

export async function refreshAccessToken(cfg: ProviderConfig, provider: OAuthProvider, refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (provider === "zoom") headers.authorization = `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`;
  else {
    body.set("client_id", cfg.clientId);
    body.set("client_secret", cfg.clientSecret);
  }
  const res = await fetch(cfg.tokenUrl, { method: "POST", headers, body });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string };
  if (!res.ok || !json.access_token) {
    const err = new Error(`Token refresh failed: ${json.error ?? res.status}`);
    (err as Error & { permanent?: boolean }).permanent = json.error === "invalid_grant";
    throw err;
  }
  return json;
}

/** Decodes the payload of an ID token received directly from the token endpoint over TLS. */
export function decodeIdToken(idToken: string): Record<string, unknown> {
  const part = idToken.split(".")[1];
  if (!part) throw new Error("Invalid id_token");
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0)))) as Record<string, unknown>;
}
