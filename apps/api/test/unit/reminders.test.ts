import { describe, expect, it } from "vitest";
import { ReminderError, checkInMessage, reminderMessage, reminderTime } from "../../src/lib/reminders.ts";

const now = new Date("2026-10-08T10:00:00Z");

describe("reminderTime", () => {
  it("converts the student's local time to UTC", () => {
    expect(reminderTime("2026-10-08T19:30", "Asia/Kolkata", now).toISOString()).toBe("2026-10-08T14:00:00.000Z");
  });
  it("accepts a time seconds in the future (minute granularity means 'next minute' can be very close)", () => {
    expect(reminderTime("2026-10-08T10:01", "UTC", new Date("2026-10-08T10:00:59Z")).toISOString()).toBe("2026-10-08T10:01:00.000Z");
  });
  it("rejects the past and the present", () => {
    expect(() => reminderTime("2026-10-08T09:59", "UTC", now)).toThrow(ReminderError);
    expect(() => reminderTime("2026-10-08T10:00", "UTC", now)).toThrow(ReminderError);
  });
  it("rejects anything more than 180 days ahead", () => {
    expect(() => reminderTime("2027-06-01T10:00", "UTC", now)).toThrow(/180 days/);
    expect(reminderTime("2027-03-01T10:00", "UTC", now)).toBeInstanceOf(Date);
  });
});

describe("message templates", () => {
  it("marks reminders fired more than 6 hours late", () => {
    expect(reminderMessage("Email TA", null, "2026-10-08T10:00:00Z", new Date("2026-10-08T10:05:00Z"))).toBe("⏰ Email TA");
    expect(reminderMessage("Email TA", "Short note", "2026-10-08T10:00:00Z", new Date("2026-10-08T17:00:00Z"))).toBe("⏰ Email TA\nShort note (delayed)");
  });
  it("builds the daily agenda from today's items, exams and a weak topic", () => {
    const text = checkInMessage({
      now: new Date("2026-10-08T02:30:00Z"),
      timezone: "Asia/Kolkata",
      displayName: "Priya",
      items: [
        { kind: "session", title: "Study: Deadlocks", dueAt: "2026-10-08T13:30:00Z", durationMin: 45 },
        { kind: "custom", title: "Email TA", dueAt: "2026-10-08T04:30:00Z" },
        { kind: "session", title: "Study: tomorrow", dueAt: "2026-10-09T13:30:00Z" },
      ],
      exams: [
        { name: "OS", examDate: "2026-10-20" },
        { name: "Old", examDate: "2026-10-01" },
      ],
      weakTopic: "Paging",
    });
    expect(text).toContain("Good morning, Priya! Today (Thursday 2026-10-08):");
    expect(text).toContain("• Reminder 10:00: Email TA");
    expect(text).toContain("• 19:00: Study: Deadlocks (45 min)");
    expect(text).not.toContain("tomorrow");
    expect(text).toContain("OS exam in 12 days");
    expect(text).not.toContain("Old");
    expect(text).toContain('Reply "quiz me on Paging"');
  });
  it("says so when there is nothing today", () => {
    expect(checkInMessage({ now, timezone: "UTC", items: [], exams: [] })).toContain("No sessions or reminders today.");
  });
});
