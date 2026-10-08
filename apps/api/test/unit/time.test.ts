import { describe, expect, it } from "vitest";
import { addDays, daysBetween, localToUtc, nextLocalOccurrence, utcToLocal } from "../../src/lib/time.ts";

describe("localToUtc / utcToLocal", () => {
  it("converts a plain wall-clock time", () => {
    expect(localToUtc("2026-10-08T09:00", "Asia/Kolkata").toISOString()).toBe("2026-10-08T03:30:00.000Z");
    expect(localToUtc("2026-10-08T09:00", "UTC").toISOString()).toBe("2026-10-08T09:00:00.000Z");
  });
  it("round-trips ordinary times", () => {
    for (const tz of ["America/New_York", "Europe/London", "Australia/Sydney", "Asia/Kolkata"]) {
      const d = localToUtc("2026-06-15T18:45", tz);
      expect(utcToLocal(d, tz)).toMatchObject({ date: "2026-06-15", time: "18:45" });
    }
  });
  it("spring forward: a non-existent local time moves forward by the gap", () => {
    // 2026-03-08 02:30 does not exist in New York; clocks jump 02:00 -> 03:00.
    expect(localToUtc("2026-03-08T02:30", "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  it("fall back: an ambiguous local time picks the first occurrence", () => {
    // 2026-11-01 01:30 happens twice in New York; the first is EDT (UTC-4).
    expect(localToUtc("2026-11-01T01:30", "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
  it("keeps the same wall-clock time across a DST change", () => {
    const before = localToUtc("2026-10-31T08:00", "America/New_York");
    const after = localToUtc("2026-11-01T08:00", "America/New_York");
    expect((after.getTime() - before.getTime()) / 3_600_000).toBe(25);
  });
  it("rejects malformed input", () => {
    expect(() => localToUtc("tomorrow 9am", "UTC")).toThrow();
  });
});

describe("date helpers", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("counts days between dates", () => {
    expect(daysBetween("2026-10-08", "2026-10-20")).toBe(12);
    expect(daysBetween("2026-10-08", "2026-10-08")).toBe(0);
  });
});

describe("nextLocalOccurrence", () => {
  it("returns today when the time is still ahead, else tomorrow", () => {
    const now = new Date("2026-10-08T01:00:00Z"); // 06:30 in Kolkata
    expect(nextLocalOccurrence("08:00", "Asia/Kolkata", now).toISOString()).toBe("2026-10-08T02:30:00.000Z");
    const later = new Date("2026-10-08T05:00:00Z"); // 10:30 in Kolkata
    expect(nextLocalOccurrence("08:00", "Asia/Kolkata", later).toISOString()).toBe("2026-10-09T02:30:00.000Z");
  });
  it("re-arming across DST keeps 08:00 local", () => {
    const first = nextLocalOccurrence("08:00", "America/New_York", new Date("2026-10-31T11:00:00Z")); // 07:00 EDT
    const second = nextLocalOccurrence("08:00", "America/New_York", first);
    expect(utcToLocal(first, "America/New_York")).toMatchObject({ date: "2026-10-31", time: "08:00" });
    expect(utcToLocal(second, "America/New_York")).toMatchObject({ date: "2026-11-01", time: "08:00" });
    expect((second.getTime() - first.getTime()) / 3_600_000).toBe(25); // the day clocks go back
  });
});
