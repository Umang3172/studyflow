import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // agents/vite compiles the TC39 decorators used by @callable().
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.mock.jsonc" },
      miniflare: { bindings: { SESSION_SECRET: "test-secret-test-secret-test-secret", MOCK_AI: "1", ALLOWED_ORIGINS: "http://localhost:5173" } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
