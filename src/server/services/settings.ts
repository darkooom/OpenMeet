import { eq } from "drizzle-orm";
import { appCredentials, instanceSettings } from "../../database/schema";
import type { AppVariables, Env } from "../env";
import { decryptString, encryptString } from "../security/crypto";

type Db = AppVariables["db"];

export interface InstanceConfig {
  setupCompleted: boolean;
  productName: string;
  defaultLocale: "en" | "de";
  defaultTimezone: string;
  publicBaseUrl: string | null;
  registration: "open" | "invite_only" | "closed";
  requireEmailVerification: boolean;
  retentionDays: number | null;
  /** Origin of the most recent request – fallback for links in background jobs when no public URL is configured. */
  lastSeenOrigin: string | null;
}

export const DEFAULT_CONFIG: InstanceConfig = {
  setupCompleted: false,
  productName: "OpenMeet",
  defaultLocale: "en",
  defaultTimezone: "UTC",
  publicBaseUrl: null,
  registration: "invite_only",
  requireEmailVerification: true,
  retentionDays: null,
  lastSeenOrigin: null,
};

export async function getConfig(db: Db): Promise<InstanceConfig> {
  const rows = await db.select().from(instanceSettings);
  const cfg: InstanceConfig = { ...DEFAULT_CONFIG };
  for (const r of rows) {
    if (r.key in cfg) {
      try {
        (cfg as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore corrupt value */
      }
    }
  }
  return cfg;
}

/** Base URL for links generated outside of a request (e-mails, webhooks). */
export function linkBaseUrl(cfg: InstanceConfig, env: { PUBLIC_BASE_URL?: string }): string {
  return (cfg.publicBaseUrl || env.PUBLIC_BASE_URL || cfg.lastSeenOrigin || "").replace(/\/+$/, "");
}

export async function setConfig(db: Db, patch: Partial<InstanceConfig>): Promise<void> {
  const now = Date.now();
  const ops = Object.entries(patch)
    .filter(([k]) => k !== "setupCompleted")
    .map(([key, value]) =>
      db
        .insert(instanceSettings)
        .values({ key, value: JSON.stringify(value), updatedAt: now })
        .onConflictDoUpdate({ target: instanceSettings.key, set: { value: JSON.stringify(value), updatedAt: now } }),
    );
  if (ops.length === 0) return;
  const [first, ...rest] = ops;
  await db.batch([first!, ...rest]);
}

export type CredentialProvider = "google" | "microsoft" | "zoom" | "email";

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}
export interface MicrosoftCredentials {
  clientId: string;
  clientSecret: string;
  tenant: string;
}
export interface ZoomCredentials {
  clientId: string;
  clientSecret: string;
}
export interface EmailCredentials {
  provider: "resend" | "brevo" | "postmark";
  apiKey: string;
  fromEmail: string;
  fromName: string;
}
export interface CredentialMap {
  google: GoogleCredentials;
  microsoft: MicrosoftCredentials;
  zoom: ZoomCredentials;
  email: EmailCredentials;
}

export async function getCredentials<K extends CredentialProvider>(db: Db, env: Env, provider: K): Promise<CredentialMap[K] | null> {
  const row = await db.select().from(appCredentials).where(eq(appCredentials.provider, provider)).get();
  if (!row) return null;
  try {
    return JSON.parse(await decryptString(env.ENCRYPTION_KEY, row.dataEnc, "app-credentials")) as CredentialMap[K];
  } catch {
    return null;
  }
}

export async function setCredentials<K extends CredentialProvider>(db: Db, env: Env, provider: K, data: CredentialMap[K] | null): Promise<void> {
  if (data === null) {
    await db.delete(appCredentials).where(eq(appCredentials.provider, provider));
    return;
  }
  const dataEnc = await encryptString(env.ENCRYPTION_KEY, JSON.stringify(data), "app-credentials");
  await db
    .insert(appCredentials)
    .values({ provider, dataEnc, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: appCredentials.provider, set: { dataEnc, updatedAt: Date.now() } });
}

export async function credentialStatus(db: Db): Promise<Record<CredentialProvider, boolean>> {
  const rows = await db.select({ provider: appCredentials.provider }).from(appCredentials);
  const set = new Set(rows.map((r) => r.provider));
  return { google: set.has("google"), microsoft: set.has("microsoft"), zoom: set.has("zoom"), email: set.has("email") };
}
