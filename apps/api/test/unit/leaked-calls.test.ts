import { describe, expect, it } from "vitest";
import { stripLeakedToolCalls as strip } from "@studyflow/shared";

describe("stripLeakedToolCalls", () => {
  const answer = "Your teaching assistant is Marisol Quintero.";

  it("removes the exact leak seen on Workers AI, with its lead-in line", () => {
    const leaked = `${answer}\n\nHere is a function call in JSON format:\n\n{"name": "createReminder", "parameters": {"localDateTime": "2026-10-15T10:00", "title": "Exam", "when": "next week"}}`;
    expect(strip(leaked)).toBe(answer);
  });

  it("removes a leak that has no lead-in, and keeps text after it", () => {
    expect(strip(`${answer} {"name":"remember","parameters":{"kind":"goal","content":"get an A"}} Anything else?`)).toBe(`${answer}\nAnything else?`);
  });

  it("hides a half-streamed block (unterminated) so the student never sees it growing", () => {
    expect(strip(`${answer}\n\nFunction call:\n{"name": "listUpcoming", "parameters": {"da`)).toBe(answer);
  });

  it("copes with braces and escaped quotes inside strings, and several blocks", () => {
    const two = `A {"name": "remember", "parameters": {"content": "a } b \\" { c"}} B {"name": "logQuizResult", "parameters": {}} C`;
    expect(strip(two)).toBe("A\nB\nC");
  });

  it("leaves ordinary text, other JSON and code alone", () => {
    for (const ok of [answer, 'In JSON: {"name": "Alice", "age": 3}', 'Use {"name": "x"} as a key', "A set is written { 1, 2, 3 }.", ""])
      expect(strip(ok)).toBe(ok);
  });

  it("does not drop a long unrelated line that merely sits before a leak", () => {
    const longLine =
      "This explanation about JSON parsing and function calls in programming languages is long enough that it is real teaching content, not a lead-in. ".repeat(
        2,
      );
    const out = strip(`${longLine.trim()}\n{"name": "remember", "parameters": {}}`);
    expect(out).toBe(longLine.trim());
  });
});
