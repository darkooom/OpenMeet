import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the real Worker (`wrangler dev`) with a fresh,
 * empty local D1 database per run – i.e. a genuine "fresh install".
 */
const PORT = 8799;
const stateDir = `.wrangler/e2e-${process.env.E2E_RUN_ID ?? Date.now()}`;
export const E2E_SETUP_TOKEN = "e2e-setup-token-0123456789abcdef0123456789";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    timezoneId: "Europe/Berlin",
    locale: "en-GB",
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite build && npx wrangler dev --port ${PORT} --persist-to ${stateDir} --var SETUP_TOKEN:${E2E_SETUP_TOKEN} --var ENCRYPTION_KEY:${"e".repeat(64)} --var ALLOWED_HOSTS:`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
