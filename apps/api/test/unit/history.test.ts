import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { BUDGET, estimateTokens } from "../../src/lib/budget.ts";
import { dropToFit, extractiveSummary, messageText, planHistory } from "../../src/lib/history.ts";

const msg = (i: number, role: "user" | "assistant", chars = 400): UIMessage => ({
  id: `m${String(i).padStart(3, "0")}`,
  role,
  parts: [{ type: "text", text: `${role} ${i} ` + "w".repeat(chars) }],
});
const convo = (turns: number, chars?: number) =>
  Array.from({ length: turns }, (_, t) => [msg(t * 2, "user", chars), msg(t * 2 + 1, "assistant", chars)]).flat();
const empty = { text: "", uptoId: null };

describe("rolling summary", () => {
  it("leaves a short conversation untouched and never calls the summariser", async () => {
    let calls = 0;
    const m = convo(5);
    const plan = await planHistory(m, empty, async () => (calls++, "x"));
    expect(calls).toBe(0);
    expect(plan.kept).toHaveLength(m.length);
    expect(plan.folded).toHaveLength(0);
  });

  it("folds older turns once the history budget is exceeded, in a single call", async () => {
    let calls = 0;
    let seen = "";
    const m = convo(40, 600); // ~ 40 * 2 * 190 tokens: well over 8000
    const plan = await planHistory(m, empty, async (prev, transcript) => ((calls++, (seen = transcript)), "SUMMARY-1"));
    expect(calls).toBe(1);
    expect(plan.summary.text).toBe("SUMMARY-1");
    expect(plan.folded.length).toBeGreaterThan(0);
    expect(plan.summary.uptoId).toBe(plan.folded[plan.folded.length - 1].id);
    expect(plan.kept[0].role).toBe("user");
    expect(plan.kept[plan.kept.length - 1].id).toBe(m[m.length - 1].id);
    const keptTokens = plan.kept.reduce((n, x) => n + estimateTokens(messageText(x)), 0);
    expect(keptTokens).toBeLessThanOrEqual(BUDGET.historyAfterSummary + 400);
    expect(seen).toContain("Student:");
  });

  it("does not re-summarise turns that are already covered", async () => {
    const m = convo(40, 600);
    const first = await planHistory(m, empty, async () => "S1");
    let calls = 0;
    const again = await planHistory(m, first.summary, async () => (calls++, "S2"));
    expect(calls).toBe(0);
    expect(again.kept.map((x) => x.id)).toEqual(first.kept.map((x) => x.id));
    expect(again.summary).toEqual(first.summary);
  });

  it("passes the previous summary to the next fold", async () => {
    const m = convo(40, 600);
    const first = await planHistory(m, empty, async () => "S1");
    const more = [...m, ...convo(30, 600).map((x, i) => ({ ...x, id: `n${i}` }))];
    let previous = "";
    await planHistory(more, first.summary, async (prev) => ((previous = prev), "S2"));
    expect(previous).toBe("S1");
  });

  it("falls back to an extractive summary when the summariser throws", async () => {
    const m = convo(40, 600);
    const plan = await planHistory(m, empty, async () => {
      throw new Error("model down");
    });
    expect(plan.summary.text).toContain("Asked: user");
    expect(plan.summary.text.length).toBeLessThanOrEqual(900);
    expect(plan.summary.uptoId).not.toBeNull();
  });

  it("keeps the whole message when one message alone exceeds the budget", async () => {
    const plan = await planHistory([msg(0, "user", 60000)], empty, async () => "x");
    expect(plan.kept).toHaveLength(1);
    expect(plan.folded).toHaveLength(0);
  });

  it("renders tool results as one-line markers", () => {
    const m: UIMessage = {
      id: "a",
      role: "assistant",
      parts: [
        { type: "tool-remember", toolCallId: "t", state: "output-available", input: {}, output: { ok: true } } as never,
        { type: "text", text: "Saved." },
      ],
    };
    expect(messageText(m)).toBe('[remember -> {"ok":true}] Saved.');
  });

  it("extractiveSummary keeps only the tail", () => {
    const long = extractiveSummary("p".repeat(2000), [msg(0, "user")]);
    expect(long.length).toBeLessThanOrEqual(900);
    expect(long).toContain("Asked: user 0");
  });

  it("dropToFit removes the oldest turns first and keeps the latest", () => {
    const m = convo(10, 3000);
    const out = dropToFit(m, 1000, 6000);
    expect(out[out.length - 1].id).toBe(m[m.length - 1].id);
    expect(out.length).toBeLessThan(m.length);
    expect(out[0].role).toBe("user");
  });
});
