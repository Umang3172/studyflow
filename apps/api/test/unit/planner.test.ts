import { describe, expect, it } from "vitest";
import type { Topic } from "@studyflow/shared";
import { allocate, PlanError, type PlannerInput } from "../../src/lib/planner.ts";
import { utcToLocal } from "../../src/lib/time.ts";

const topics = (n: number, difficulty: 1 | 2 | 3 = 1): Topic[] =>
  Array.from({ length: n }, (_, i) => ({ title: `Topic ${i + 1}`, difficulty, objective: `Objective ${i + 1}` }));

const base = (over: Partial<PlannerInput> = {}): PlannerInput => ({
  topics: topics(4),
  today: "2026-10-08",
  nowLocalTime: "10:00",
  examDate: "2026-10-20",
  minutesPerDay: 90,
  sessionMinutes: 45,
  preferredTime: "19:00",
  timezone: "UTC",
  ...over,
});

describe("allocate", () => {
  it("builds learn, review and final sessions inside the window, sorted", () => {
    const r = allocate(base());
    expect(r.overloaded).toBe(false);
    const kinds = new Set(r.sessions.map((s) => s.kind));
    expect(kinds).toEqual(new Set(["learn", "review", "final"]));
    expect(r.sessions.filter((s) => s.kind === "learn")).toHaveLength(4);
    const starts = r.sessions.map((s) => s.startsAt);
    expect([...starts].sort()).toEqual(starts);
    expect(starts.every((s) => s >= "2026-10-08" && s < "2026-10-20")).toBe(true);
    expect(r.sessions.at(-1)).toMatchObject({ kind: "final" });
    expect(r.sessions.at(-1)!.startsAt.startsWith("2026-10-19")).toBe(true);
  });

  it("schedules two slots per day when minutesPerDay allows, 10 minutes apart", () => {
    const r = allocate(base({ topics: topics(4) }));
    const day1 = r.sessions.filter((s) => s.startsAt.startsWith("2026-10-08"));
    expect(day1.map((s) => s.startsAt.slice(11, 16))).toEqual(["19:00", "19:55"]);
  });

  it("splits a difficulty-3 topic into two learn sessions", () => {
    const r = allocate(base({ topics: topics(2, 3) }));
    expect(r.sessions.filter((s) => s.kind === "learn")).toHaveLength(4);
    expect(r.sessions.some((s) => s.topic.includes("part 1/2"))).toBe(true);
  });

  it("exam tomorrow: one study day, no final reservation", () => {
    const r = allocate(base({ examDate: "2026-10-09", topics: topics(2) }));
    expect(r.sessions.length).toBeGreaterThan(0);
    expect(r.sessions.every((s) => s.startsAt.startsWith("2026-10-08"))).toBe(true);
    expect(r.sessions.some((s) => s.kind === "final")).toBe(false);
  });

  it("exam tomorrow and today's slot already passed: too soon", () => {
    expect(() => allocate(base({ examDate: "2026-10-09", nowLocalTime: "20:00" }))).toThrow(PlanError);
  });

  it("exam today or in the past is an error", () => {
    expect(() => allocate(base({ examDate: "2026-10-08" }))).toThrow(PlanError);
  });

  it("30 topics in 5 days: groups topics, flags overloaded, suggests more time", () => {
    const r = allocate(base({ topics: topics(30), examDate: "2026-10-13", minutesPerDay: 90 }));
    expect(r.overloaded).toBe(true);
    expect(r.sessions.length).toBeLessThanOrEqual(120);
    expect(r.sessions.filter((s) => s.kind === "learn").every((s) => s.topic.includes(" + "))).toBe(true);
    // every topic still appears somewhere
    const text = r.sessions.map((s) => s.topic).join("|");
    for (let i = 1; i <= 30; i++) expect(text).toContain(`Topic ${i}`);
  });

  it("drops +7 reviews before anything else when capacity is tight", () => {
    const r = allocate(base({ topics: topics(6), examDate: "2026-10-18", minutesPerDay: 45 }));
    expect(r.overloaded).toBe(false);
    expect(r.sessions.filter((s) => s.kind === "learn")).toHaveLength(6);
  });

  it("minutesPerDay below the session length still gives one slot a day", () => {
    const r = allocate(base({ minutesPerDay: 30, sessionMinutes: 45, topics: topics(2) }));
    const perDay = new Map<string, number>();
    for (const s of r.sessions) perDay.set(s.startsAt.slice(0, 10), (perDay.get(s.startsAt.slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBe(1);
  });

  it("preferred time already passed today starts tomorrow", () => {
    const r = allocate(base({ nowLocalTime: "19:30" }));
    expect(r.sessions[0].startsAt.startsWith("2026-10-09")).toBe(true);
  });

  it("keeps local wall-clock time across a DST change", () => {
    const r = allocate(base({ today: "2026-10-28", examDate: "2026-11-06", timezone: "America/New_York", topics: topics(6) }));
    for (const s of r.sessions.filter((x) => x.kind === "learn")) {
      expect(utcToLocal(s.startsAt, "America/New_York").time).toMatch(/^19:00|19:55$/);
    }
    const days = new Set(r.sessions.map((s) => utcToLocal(s.startsAt, "America/New_York").date));
    expect(days.has("2026-11-01")).toBe(true);
  });

  it("never exceeds the 120-session cap", () => {
    const r = allocate(base({ topics: topics(30, 3), examDate: "2027-02-01", minutesPerDay: 240, sessionMinutes: 25 }));
    expect(r.sessions.length).toBeLessThanOrEqual(120);
  });
});
