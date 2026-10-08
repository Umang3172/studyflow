import { describe, expect, it } from "vitest";
import { ganttSource, safeLabel } from "@studyflow/shared";

describe("ganttSource", () => {
  it("draws one bar per topic from first learn to last review, plus the final day", () => {
    const src = ganttSource([
      { date: "2026-10-09", kind: "learn", topic: "Deadlocks (part 1/2)" },
      { date: "2026-10-10", kind: "learn", topic: "Deadlocks (part 2/2)" },
      { date: "2026-10-13", kind: "review", topic: "Deadlocks" },
      { date: "2026-10-11", kind: "learn", topic: "Paging" },
      { date: "2026-10-19", kind: "final", topic: "Mixed review and practice test" },
    ]);
    expect(src).toContain("gantt\n  dateFormat YYYY-MM-DD\n  axisFormat %d %b\n  tickInterval");
    expect(src).toContain("Deadlocks :t1, 2026-10-09, 5d");
    expect(src).toContain("Paging :t2, 2026-10-11, 1d");
    expect(src).toContain("section Final prep\n  Practice test :t3, 2026-10-19, 1d");
    expect(src.match(/:t\d+,/g)).toHaveLength(3);
  });
  it("neutralises Mermaid syntax and markup smuggled in via topic titles", () => {
    expect(safeLabel('Evil: click foo "call x()" ; <script>alert(1)</script> #end')).not.toMatch(/[:;<>"#]/);
    const src = ganttSource([{ date: "2026-10-09", kind: "learn", topic: "A\nsection Hacked\n  Pwned :x, 2026-01-01, 1d" }]);
    expect(src.split("\n").filter((l) => l.startsWith("  section"))).toEqual(["  section Topics"]);
    expect(src.match(/:t\d+,/g)).toHaveLength(1);
  });
  it("keeps non-Latin letters", () => {
    expect(safeLabel("प्रक्रिया शेड्यूलिंग")).toBe("प्रक्रिया शेड्यूलिंग");
  });
  it("ignores items with bad dates and handles an empty plan", () => {
    expect(ganttSource([{ date: "tomorrow", kind: "learn", topic: "x" }])).not.toContain("tomorrow");
    expect(ganttSource([]).startsWith("gantt\n")).toBe(true);
    expect(ganttSource([])).not.toContain("section");
  });
});
