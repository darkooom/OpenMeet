import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../database/schema";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SETUP_TOKEN?: string;
  ENCRYPTION_KEY?: string;
  PUBLIC_BASE_URL?: string;
  ALLOWED_HOSTS?: string;
  APP_VERSION?: string;
  /** Only set by the test harness. Enables the mock providers. */
  OPENMEET_TEST_MODE?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  username: string;
  timezone: string;
  locale: string;
  isSuperAdmin: boolean;
  emailVerified: boolean;
}

export type Actor =
  | { type: "user"; user: SessionUser; sessionId: string }
  | { type: "api_key"; user: SessionUser; apiKeyId: string; scopes: string[] };

export interface AppVariables {
  db: DrizzleD1Database<typeof schema>;
  actor: Actor | null;
  baseUrl: string;
  ip: string;
  requestId: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
