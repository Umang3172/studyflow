import { defineConfig, devices } from "@playwright/test";

// Runs the real SPA (Vite) against the real Worker (wrangler dev, mock model, throwaway state) in Chrome.
// Locally set PW_CHANNEL=chrome to use the installed Chrome; CI installs Playwright's own Chromium.
const channel = process.env.PW_CHANNEL || undefined;
const ci = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: ci ? 2 : 3,
  retries: ci ? 1 : 0,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:5173", timezoneId: "UTC", locale: "en-US", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel }, testMatch: /a11y\.spec\.ts/ },
  ],
  webServer: [
    { command: "npm run dev:e2e -w apps/api", cwd: "../..", url: "http://localhost:8787/api/health", reuseExistingServer: !ci, timeout: 120_000 },
    { command: "npm run dev -w apps/web", cwd: "../..", url: "http://localhost:5173", reuseExistingServer: !ci, timeout: 60_000 },
  ],
});
