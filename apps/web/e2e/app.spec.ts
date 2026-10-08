import { expect, test } from "@playwright/test";
import { composer, generatePlan, inDays, onboard, openTab, send, utcMinute } from "./helpers.ts";

test("onboarding, then a streamed reply and live usage counters", async ({ page }) => {
  await onboard(page, "Priya");
  await expect(page.getByText("Hi, Priya")).toBeVisible();
  await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible();
  await send(page, "Explain deadlocks to me");
  await expect(page.getByRole("log").getByText(/Mock coach/)).toBeVisible();
  await expect(page.getByText("1/40 messages today")).toBeVisible();
  await expect(composer(page)).toBeFocused();
});

test("history and state survive a reload (same anonymous student)", async ({ page }) => {
  await onboard(page, "Sam");
  await send(page, "Please explain paging before my exam");
  await expect(page.getByRole("log").getByText(/Mock coach/)).toBeVisible();
  await page.reload();
  await expect(page.getByText("Hi, Sam")).toBeVisible();
  await expect(page.getByRole("log").getByText("Please explain paging before my exam", { exact: true })).toBeVisible();
});

test("a reminder created in chat is listed, can be cancelled, and one left alone fires", async ({ page }) => {
  test.slow(); // waits for a real alarm up to a minute away
  await onboard(page);
  const cancelMe = utcMinute(10);
  await send(page, `remind me ${cancelMe} to cancel this one`);
  await expect(page.getByRole("log").getByText(/Reminder for/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel reminder cancel this one" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel reminder cancel this one" }).click();
  await expect(page.getByRole("complementary").getByText("cancel this one")).toHaveCount(0);

  // The next minute boundary: fires within about a minute.
  await send(page, `remind me ${utcMinute(1)} to stretch and drink water`);
  await expect(page.getByRole("complementary").getByText("stretch and drink water")).toBeVisible();
  await expect(page.getByRole("log").getByText("⏰ stretch and drink water")).toBeVisible({ timeout: 100_000 });
  await expect(page.locator('[aria-live="polite"]').getByText("stretch and drink water").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Cancel reminder stretch/ })).toHaveCount(0); // left the schedule
});

test("study plan: generate, review the chart, approve, sessions appear in Today", async ({ page }) => {
  await onboard(page);
  await openTab(page, "Plan");
  await generatePlan(page);
  await expect(page.getByRole("img", { name: "Study timeline chart" }).locator("svg")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Nothing is scheduled until you approve.")).toBeVisible();
  await page.getByRole("button", { name: "Approve and schedule" }).click();
  await expect(page.getByRole("heading", { name: /active plan/ })).toBeVisible({ timeout: 30_000 });
  await openTab(page, "Today");
  await expect(page.getByText(/Study: Process scheduling/)).toBeVisible();
});

test("study plan: discarding leaves nothing scheduled", async ({ page }) => {
  await onboard(page);
  await openTab(page, "Plan");
  await generatePlan(page);
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Plan discarded. No reminders were created.")).toBeVisible();
  await openTab(page, "Today");
  await expect(page.getByText(/Study:/)).toHaveCount(0);
});

test("chat-driven plan needs approval, then reads the pasted syllabus", async ({ page }) => {
  await onboard(page);
  const box = composer(page);
  await box.fill(`My syllabus:\n${"Relational algebra\nQuery optimization\nConcurrency control and locking"}`);
  await box.press("Enter");
  await expect(page.getByRole("log").getByText(/Mock coach/)).toBeVisible();
  await send(page, `make me a plan for Databases exam ${inDays(12)}`);
  await expect(page.getByText("Approve: Study plan?")).toBeVisible();
  await openTab(page, "Plan");
  await expect(page.getByRole("heading", { name: /Review your plan/ })).toHaveCount(0); // nothing started before approval
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Review your plan: Databases/ })).toBeVisible({ timeout: 45_000 });
});

test("memory: saved from chat, listed, and forgotten on request", async ({ page }) => {
  await onboard(page);
  await send(page, "remember that I like worked examples");
  await expect(page.getByRole("log").getByText("Saved to memory")).toBeVisible();
  await openTab(page, "Memory");
  await expect(page.getByRole("complementary").getByText("I like worked examples", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Forget: / }).click();
  await expect(page.getByText("Nothing yet.")).toBeVisible();
});

test("live state is shared between two tabs of the same student", async ({ page, context }) => {
  await onboard(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(composer(other)).toBeVisible();
  await send(page, `remind me ${utcMinute(30)} to read chapter 4`);
  await expect(other.getByText("read chapter 4").first()).toBeVisible({ timeout: 15_000 });
});

test("delete all my data returns to onboarding with a fresh student", async ({ page }) => {
  await onboard(page, "Temp");
  await send(page, "hello");
  await expect(page.getByRole("log").getByText(/Mock coach/)).toBeVisible();
  await openTab(page, "Settings");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete all my data" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to Studyflow" })).toBeVisible({ timeout: 30_000 });
});

test("the API refuses state-changing requests that come from another origin", async ({ page }) => {
  await onboard(page);
  // The browser context's cookies are attached, but the Origin is foreign: this must be refused.
  const res = await page.request.post("http://localhost:8787/api/account/delete", { headers: { origin: "https://evil.example" } });
  expect(res.status()).toBe(403);
  await page.reload();
  await expect(page.getByText("Hi, Priya")).toBeVisible(); // the student's data is untouched
});
