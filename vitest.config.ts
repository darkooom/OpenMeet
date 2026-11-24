import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import type { Plugin } from "vite";

/** Mirrors Wrangler's "Text" module rule for *.sql in the plain Node test project. */
const sqlText: Plugin = {
  name: "sql-text",
  transform(code, id) {
    if (id.endsWith(".sql")) return { code: `export default ${JSON.stringify(code)};`, map: null };
    return null;
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [sqlText],
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./src/server/index.ts",
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                SETUP_TOKEN: "test-setup-token-0123456789abcdef",
                ENCRYPTION_KEY: "a".repeat(64),
                // Disables opportunistic background job processing; tests drain jobs explicitly.
                OPENMEET_TEST_MODE: "1",
              },
            },
          }),
        ],
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 30000,
        },
      },
    ],
  },
});
