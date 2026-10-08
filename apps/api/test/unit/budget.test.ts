import { describe, expect, it } from "vitest";
import { asSchema } from "ai";
import { BUDGET, DIVISOR, clipToTokens, estimateTokens, fitFromEnd, llamaNeurons } from "../../src/lib/budget.ts";
import { buildContext } from "../../src/lib/context.ts";
import type { Memory } from "../../src/lib/memory.ts";
import { TUTOR_SYSTEM } from "../../src/lib/prompts.ts";
import { studyTools, type ToolHost } from "../../src/lib/tools.ts";

const mem = (i: number, kind: Memory["kind"] = "fact", content = `Fact number ${i} about the student ${"x".repeat(120)}`): Memory => ({
  id: `m${i}`.padEnd(8, "0"),
  kind,
  content,
  course_id: null,
  created_at: `2026-10-0${(i % 9) + 1}T00:00:00Z`,
  updated_at: `2026-10-0${(i % 9) + 1}T00:00:00Z`,
});

describe("token budget", () => {
  it("estimates from the calibrated chars-per-token ratio", () => {
    expect(DIVISOR).toBe(3.0);
    expect(estimateTokens("a".repeat(30))).toBe(10);
    expect(estimateTokens("")).toBe(0);
  });

  it("stays within 15% of the real first-turn prompt measured on Workers AI (4,521 chars = 1,650 tokens)", () => {
    const estimate = estimateTokens("x".repeat(4521));
    expect(Math.abs(estimate - 1650) / 1650).toBeLessThan(0.15);
  });

  it("fitFromEnd keeps the newest items and always the last one", () => {
    const items = [{ tokens: 500 }, { tokens: 500 }, { tokens: 500 }];
    expect(fitFromEnd(items, 1000)).toBe(1);
    expect(fitFromEnd(items, 10)).toBe(2); // last item kept even when it alone exceeds the budget
    expect(fitFromEnd([], 100)).toBe(0);
  });

  it("clipToTokens truncates with an ellipsis", () => {
    const out = clipToTokens("word ".repeat(1000), 50);
    expect(estimateTokens(out)).toBeLessThanOrEqual(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("P1 system prompt stays within its budget", () => {
    expect(estimateTokens(TUTOR_SYSTEM)).toBeLessThanOrEqual(BUDGET.system);
  });

  it("the six tool schemas, as sent to the model, stay within the tools budget", () => {
    const stub = new Proxy({}, { get: () => () => ({}) }) as ToolHost;
    const tools = studyTools(stub);
    expect(Object.keys(tools)).toHaveLength(6);
    const serialized = JSON.stringify(
      Object.entries(tools).map(([name, t]) => ({
        type: "function",
        function: { name, description: t.description, parameters: asSchema(t.inputSchema as never).jsonSchema },
      })),
    );
    expect(estimateTokens(serialized)).toBeLessThanOrEqual(BUDGET.tools);
    expect(serialized).not.toMatch(/pattern|additionalProperties|\$schema|maxLength/); // validation-only keywords stay server-side
  });

  it("the student context stays within budget even with many memories, and keeps the header", () => {
    const memories = Array.from({ length: 50 }, (_, i) => mem(i));
    const upcoming = Array.from({ length: 8 }, (_, i) => ({
      id: `rem${i}xxxxx`,
      title: `Reminder number ${i} ${"y".repeat(100)}`,
      dueAt: "2026-10-09T10:00:00Z",
    }));
    const out = buildContext({
      now: new Date("2026-10-08T10:00:00Z"),
      timezone: "Asia/Kolkata",
      displayName: "Priya",
      courses: [{ name: "Operating Systems", examDate: "2026-10-20" }],
      plan: { course: "Operating Systems", done: 3, total: 20, next: { topic: "Deadlocks", startsAt: "2026-10-09T13:30:00Z" } },
      upcoming,
      memories,
      summary: "s".repeat(5000),
      query: "deadlocks",
    });
    expect(estimateTokens(out)).toBeLessThanOrEqual(BUDGET.context);
    expect(out).toContain("CURRENT LOCAL TIME: Thursday 2026-10-08 15:30 (Asia/Kolkata)");
    expect(out).toContain("exam 2026-10-20, in 12 days");
    expect(out).toContain("next: Deadlocks at 2026-10-09 19:00");
    expect(out.match(/<\/?student_context>/g)).toHaveLength(2);
  });

  it("puts relevant memories first and strips markup from memory text", () => {
    const out = buildContext({
      now: new Date("2026-10-08T10:00:00Z"),
      timezone: "UTC",
      courses: [],
      upcoming: [],
      memories: [mem(1, "fact", "likes cats"), mem(2, "fact", "struggles with <b>recursion</b> trees"), mem(3, "goal", "get an A")],
      query: "explain recursion",
    });
    const lines = out.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines[0]).toBe("- [goal] get an A"); // goal outranks relevance of a fact (5 vs 1+3)
    expect(lines[1]).toContain("recursion");
    expect(out).not.toContain("<b>");
  });

  it("converts tokens to neurons with the published rates", () => {
    expect(Math.round(llamaNeurons(6000, 400))).toBe(242);
  });
});
