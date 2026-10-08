import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { composer, generatePlan, onboard, openTab, send } from "./helpers.ts";

// WCAG 2.2 A and AA rules from axe-core, on every screen, in light and dark mode, on desktop and a phone.
// Axe finds roughly a third of accessibility problems; keyboard, reflow and live-region checks below cover some more.
// Screen-reader behaviour (VoiceOver, NVDA) is not covered: see docs/a11y.md.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

// Violations are collected across all screens and asserted once at the end, so a run lists everything that is wrong.
async function scan(page: Page, screen: string, found: string[]) {
  // Colours are sampled mid-transition otherwise (a button that just became "pressed" is still fading in).
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of results.violations) {
    found.push(
      `${screen}: ${v.id} [${v.impact}] ${v.help}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.html.slice(0, 140)} (${n.any[0]?.message ?? ""})`).join(" | ")}`,
    );
  }
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    test(`every screen has no axe violations (${scheme})`, async ({ page }) => {
      const found: string[] = [];
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Welcome to Studyflow" })).toBeVisible();
      await scan(page, "onboarding", found);

      await onboard(page, "Priya");
      await scan(page, "chat empty + today", found);

      await send(page, "Explain deadlocks to me");
      await expect(page.getByRole("log").getByText(/Mock coach/)).toBeVisible();
      await send(page, "remember that I like worked examples");
      await expect(page.getByRole("log").getByText("Saved to memory")).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0); // reply finished streaming
      await expect(page.getByRole("button", { name: "Clear chat" })).toBeEnabled();
      await scan(page, "chat with messages", found);

      const narrow = (page.viewportSize()?.width ?? 1024) < 768;
      await openTab(page, "Plan");
      await scan(page, "plan form", found);
      await generatePlan(page);
      await expect(page.getByRole("img", { name: "Study timeline chart" }).locator("svg")).toBeVisible({ timeout: 20_000 });
      await scan(page, "plan review", found);
      await page.getByRole("button", { name: "Approve and schedule" }).click();
      await expect(page.getByRole("heading", { name: /active plan/ })).toBeVisible({ timeout: 30_000 });
      await scan(page, "plan active", found);

      await openTab(page, "Memory");
      await expect(page.getByRole("complementary").getByText("I like worked examples", { exact: true })).toBeVisible();
      await scan(page, "memory", found);

      await openTab(page, "Settings");
      await expect(page.getByRole("heading", { name: "AI usage, last 30 days" })).toBeVisible();
      await scan(page, "settings", found);

      await openTab(page, "Today");
      await scan(page, narrow ? "today (mobile)" : "today", found);
      expect(found, "axe violations").toEqual([]);
    });
  });
}

test("keyboard only: the whole chat flow and panel navigation work without a mouse", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard walkthrough runs on desktop");
  await onboard(page, "Kay");
  // Tab from the top until the message box has focus; every stop must show a visible focus indicator.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const stops: string[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        name: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 30) || el.tagName,
        outline: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2,
        isMessage: el.id === "composer",
      };
    });
    if (!info) continue;
    stops.push(info.name);
    expect(info.outline, `focus indicator on "${info.name}"`).toBe(true);
    if (info.isMessage) break;
  }
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type("Quiz me please");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log").getByText(/Mock coach/)).toBeVisible();
  await expect(composer(page)).toBeFocused(); // focus is not stolen when the reply streams in
  // Panels are reachable and operable by keyboard.
  await page.getByRole("button", { name: "Memory", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "What I remember about you" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  expect(stops.length).toBeGreaterThan(3);
});

test("live regions announce chat and toasts politely", async ({ page, isMobile }) => {
  test.skip(isMobile);
  await onboard(page);
  await expect(page.getByRole("log", { name: "Conversation" })).toHaveAttribute("aria-live", "polite");
  expect(await page.locator('[aria-live="polite"][role="status"]').count()).toBeGreaterThan(0);
});

test("content reflows at 320px wide (no horizontal scrolling) on key screens", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Studyflow" })).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow(), "onboarding").toBeLessThanOrEqual(0);
  await onboard(page);
  await send(page, "Explain deadlocks in detail please, with a long sentence that could overflow the bubble");
  await expect(page.getByRole("log").getByText(/Mock coach/)).toBeVisible();
  expect(await overflow(), "chat").toBeLessThanOrEqual(0);
  for (const tab of ["Today", "Plan", "Memory", "Settings"] as const) {
    await openTab(page, tab);
    expect(await overflow(), tab).toBeLessThanOrEqual(0);
  }
});

test("respects reduced motion and text zoom", async ({ page, isMobile }) => {
  test.skip(isMobile);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await onboard(page);
  const dur = await page.evaluate(() => getComputedStyle(document.querySelector("button")!).transitionDuration);
  expect(parseFloat(dur)).toBeLessThan(0.01);
  await page.addStyleTag({ content: "html { font-size: 200% }" }); // 200% text size
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});
