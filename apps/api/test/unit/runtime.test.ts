import { expect, it } from "vitest";

// Spike S3 as a regression test: record what the runtime offers so a future change is noticed.
it("workerd provides Intl time zone support; Temporal availability is recorded, not required", () => {
  expect(typeof Intl.DateTimeFormat).toBe("function");
  expect(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone).toBe("Asia/Calcutta");
  // Our time helpers use Intl only. If Temporal ever ships in workerd this test will still pass either way.
  expect(["undefined", "object"]).toContain(typeof (globalThis as { Temporal?: unknown }).Temporal);
});
