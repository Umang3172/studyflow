import { describe, expect, it } from "vitest";
import { createReminderInput, id, listUpcomingInput, logQuizInput, onboardingInput, planRequest, rememberInput } from "@studyflow/shared";

describe("tool and callable schemas", () => {
  it("createReminder needs a real local date-time, not prose", () => {
    expect(createReminderInput.safeParse({ title: "Email TA", localDateTime: "2026-10-10T10:00" }).success).toBe(true);
    for (const bad of ["tomorrow 9am", "2026-10-10 10:00", "2026-13-10T10:00", "2026-02-30T10:00", "2026-10-10T25:00"]) {
      expect(createReminderInput.safeParse({ title: "x", localDateTime: bad }).success, bad).toBe(false);
    }
    expect(createReminderInput.safeParse({ title: " ", localDateTime: "2026-10-10T10:00" }).success).toBe(false);
  });
  it("remember enforces the kind enum and the 280 character cap", () => {
    expect(rememberInput.safeParse({ kind: "weak_topic", content: "paging" }).success).toBe(true);
    expect(rememberInput.safeParse({ kind: "secret", content: "x" }).success).toBe(false);
    expect(rememberInput.safeParse({ kind: "fact", content: "x".repeat(281) }).success).toBe(false);
  });
  it("logQuiz coerces numbers and rejects correct > total", () => {
    expect(logQuizInput.parse({ topic: "Paging", correct: "3", total: "5" })).toMatchObject({ correct: 3, total: 5 });
    expect(logQuizInput.safeParse({ topic: "Paging", correct: 6, total: 5 }).success).toBe(false);
  });
  it("listUpcoming defaults to 7 days and clamps the range", () => {
    expect(listUpcomingInput.parse({}).days).toBe(7);
    expect(listUpcomingInput.safeParse({ days: 90 }).success).toBe(false);
  });
  it("ids must match the safe pattern", () => {
    expect(id.safeParse("abc12345").success).toBe(true);
    for (const bad of ["short", "UPPERCASE1", "has space 1", "x".repeat(41), "a/../b12345"]) expect(id.safeParse(bad).success, bad).toBe(false);
  });
  it("planRequest applies defaults and enforces ranges", () => {
    const ok = planRequest.parse({ courseName: "OS", examDate: "2026-10-20", material: "Deadlocks, paging, scheduling", minutesPerDay: 90 });
    expect(ok).toMatchObject({ sessionMinutes: 45, preferredTime: "19:00" });
    expect(planRequest.safeParse({ ...ok, minutesPerDay: 10 }).success).toBe(false);
    expect(planRequest.safeParse({ ...ok, material: "x".repeat(12_001) }).success).toBe(false);
    expect(planRequest.safeParse({ ...ok, material: "short" }).success).toBe(false);
  });
  it("onboarding validates timezone and caps courses at 10", () => {
    const base = { timezone: "Asia/Kolkata", courses: [] };
    expect(onboardingInput.safeParse(base).success).toBe(true);
    expect(onboardingInput.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(onboardingInput.safeParse({ ...base, courses: Array.from({ length: 11 }, (_, i) => ({ name: `c${i}` })) }).success).toBe(false);
    expect(onboardingInput.parse(base).checkInTime).toBe("08:00");
  });
});
