import { LIMITS } from "@studyflow/shared";
import { greeting, localToUtc, daysBetween, utcToLocal } from "./time.ts";

export class ReminderError extends Error {}

const MIN = 60_000;
const DAY = 86_400_000;

/** Validate a student-supplied local date-time and convert it to the UTC instant to schedule. */
export function reminderTime(localDateTime: string, timezone: string, now: Date): Date {
  const at = localToUtc(localDateTime, timezone);
  if (at.getTime() <= now.getTime()) throw new ReminderError("That time is in the past. Ask the student for a future time.");
  if (at.getTime() > now.getTime() + LIMITS.reminderMaxDays * DAY) throw new ReminderError(`Reminders can be at most ${LIMITS.reminderMaxDays} days ahead.`);
  return at;
}

/** P5: reminder message (no LLM). */
export function reminderMessage(title: string, body: string | null | undefined, dueAt: string, now: Date): string {
  const late = now.getTime() - Date.parse(dueAt) > 6 * 60 * MIN;
  return `⏰ ${title}${body ? `\n${body}` : ""}${late ? " (delayed)" : ""}`;
}

export type AgendaInput = {
  now: Date;
  timezone: string;
  displayName?: string;
  items: Array<{ kind: string; title: string; dueAt: string; durationMin?: number }>;
  exams: Array<{ name: string; examDate: string }>;
  weakTopic?: string;
};

/** P4: daily check-in agenda (no LLM). */
export function checkInMessage(a: AgendaInput): string {
  const here = utcToLocal(a.now, a.timezone);
  const icon = { morning: "☀️", afternoon: "🌤️", evening: "🌙" }[greeting(here.time)];
  const lines = [`${icon} Good ${greeting(here.time)}${a.displayName ? `, ${a.displayName}` : ""}! Today (${here.weekday} ${here.date}):`];
  const today = a.items.filter((i) => utcToLocal(i.dueAt, a.timezone).date === here.date);
  if (!today.length) lines.push("No sessions or reminders today.");
  for (const i of today) {
    const t = utcToLocal(i.dueAt, a.timezone).time;
    lines.push(i.kind === "custom" ? `• Reminder ${t}: ${i.title}` : `• ${t}: ${i.title}${i.durationMin ? ` (${i.durationMin} min)` : ""}`);
  }
  for (const e of a.exams) {
    const n = daysBetween(here.date, e.examDate);
    if (n >= 0) lines.push(`📅 ${e.name} exam ${n === 0 ? "is today" : `in ${n} day${n === 1 ? "" : "s"}`}`);
  }
  if (a.weakTopic) lines.push(`Reply "quiz me on ${a.weakTopic}" for a quick warm-up.`);
  return lines.join("\n");
}
