#!/usr/bin/env node
/**
 * Deploy script used by `npm run deploy`, the Deploy-to-Cloudflare button and
 * Workers Builds.
 *
 * 1. Apply pending D1 migrations (by binding name, so renamed databases work).
 * 2. Deploy the Worker (Wrangler provisions missing resources automatically).
 * 3. If step 1 could not run (e.g. the database did not exist yet on a first
 *    manual deploy), retry it now. Should that still fail, the Worker's
 *    runtime migrator applies the same migrations on the first request – it
 *    shares Wrangler's `d1_migrations` bookkeeping table, so nothing runs twice.
 */
import { spawnSync } from "node:child_process";

function wrangler(args) {
  const res = spawnSync("npx", ["wrangler", ...args], { stdio: "inherit", env: { ...process.env, CI: process.env.CI ?? "true" } });
  return res.status === 0;
}

const migrateArgs = ["d1", "migrations", "apply", "DB", "--remote"];

const migratedBefore = wrangler(migrateArgs);
if (!migratedBefore) console.warn("\n[openmeet] Migrations could not be applied before deploying – retrying after deployment.\n");

if (!wrangler(["deploy"])) {
  console.error("\n[openmeet] wrangler deploy failed.");
  process.exit(1);
}

if (!migratedBefore && !wrangler(migrateArgs)) {
  console.warn("\n[openmeet] Migrations will be applied automatically on the first request (runtime migrator).\n");
}
