import { expect, type Page } from "@playwright/test";

export const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** UTC "YYYY-MM-DDTHH:mm" N minutes from now (the browser runs in UTC, see playwright.config.ts). */
export const utcMinute = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 16);

export const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });

export async function onboard(page: Page, name = "Priya") {
  await page.goto("/");
  await page.getByLabel("What should I call you? (optional)").fill(name);
  await page.getByRole("button", { name: "Start studying" }).click();
  await expect(composer(page)).toBeVisible();
}

export async function send(page: Page, text: string) {
  // Enter is ignored while a reply is streaming (by design), so wait for the Stop button to go away first.
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** Open a right-hand panel (desktop) or full-screen section (mobile). */
export async function openTab(page: Page, name: "Today" | "Plan" | "Memory" | "Settings" | "Chat") {
  await page.getByRole("button", { name, exact: true }).click();
}

export const SYLLABUS = [
  "Process scheduling",
  "Deadlocks",
  "Paging and virtual memory",
  "File systems",
  "Synchronization primitives",
  "I/O and interrupts",
].join("\n");

/** Fill and submit the New study plan form. */
export async function generatePlan(page: Page, course = "Operating Systems") {
  await page.getByLabel("Course", { exact: true }).fill(course);
  await page.getByLabel("Exam date").fill(inDays(14));
  await page.getByLabel("Topics or syllabus (paste text)").fill(SYLLABUS);
  await page.getByRole("button", { name: "Generate plan" }).click();
  await expect(page.getByRole("heading", { name: /Review your plan/ })).toBeVisible({ timeout: 45_000 });
}
