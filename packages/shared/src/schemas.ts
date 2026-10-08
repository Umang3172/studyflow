import { z } from "zod";
import { LIMITS } from "./limits.ts";

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};
const isTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealDate, "not a real date");
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:mm");
export const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, "use YYYY-MM-DDTHH:mm")
  .refine((s) => isRealDate(s.slice(0, 10)), "not a real date");
export const ianaTimezone = z.string().max(64).refine(isTimezone, "unknown timezone");
// Ids come only from our own tools/state; the model must never invent them.
export const id = z.string().regex(/^[a-z0-9_-]{8,40}$/, "bad id");

const text = (max: number) => z.string().trim().min(1).max(max);

export const memoryKind = z.enum(["goal", "preference", "weak_topic", "strength", "fact"]);
export type MemoryKind = z.infer<typeof memoryKind>;

// --- chat tool inputs (kept small: they are sent to the model on every turn) ---
export const rememberInput = z.object({
  kind: memoryKind,
  content: text(LIMITS.memoryChars),
  course: text(LIMITS.courseNameChars).optional(),
});
export const createReminderInput = z.object({
  title: text(LIMITS.reminderTitleChars),
  localDateTime,
});
export const listUpcomingInput = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) });
export const cancelReminderInput = z.object({ reminderId: id });
export const logQuizInput = z
  .object({
    topic: text(80),
    correct: z.coerce.number().int().min(0).max(20),
    total: z.coerce.number().int().min(1).max(20),
    course: text(LIMITS.courseNameChars).optional(),
  })
  .refine((v) => v.correct <= v.total, "correct cannot exceed total");

// --- plans ---
export const planRequest = z.object({
  courseName: text(LIMITS.courseNameChars),
  examDate: ymd,
  material: z.string().trim().min(10, "paste your topics or syllabus").max(LIMITS.materialChars),
  minutesPerDay: z.coerce.number().int().min(30).max(240),
  sessionMinutes: z.coerce.number().int().min(25).max(90).default(45),
  preferredTime: hhmm.default("19:00"),
});
export type PlanRequest = z.infer<typeof planRequest>;

// Chat-tool variant: the model passes at most a short topic list. A long pasted syllabus is read by the server from
// the chat history, so the model never has to copy up to 12,000 characters into a tool call.
export const planToolInput = planRequest.omit({ material: true }).extend({
  topics: z.string().trim().min(10).max(600).optional(),
});

// LLM output is untrusted: coerce loosely, then clamp so one long string cannot fail the plan.
const clip = (n: number) =>
  z
    .string()
    .trim()
    .min(1)
    .transform((s) => s.slice(0, n));
export const topicSchema = z.object({
  title: clip(80),
  difficulty: z.coerce.number().int().min(1).max(3),
  objective: clip(140).catch("Understand and practise this topic"),
});
export const topicsOutput = z.object({ topics: z.array(topicSchema).max(LIMITS.topicsMax) });
export type Topic = z.infer<typeof topicSchema>;

// --- callable args ---
const course = z.object({ name: text(LIMITS.courseNameChars), examDate: ymd.optional() });
export const onboardingInput = z.object({
  displayName: text(LIMITS.displayNameChars).optional(),
  timezone: ianaTimezone,
  checkInTime: hhmm.default("08:00"),
  courses: z.array(course).max(LIMITS.courses),
});
export const profileUpdate = onboardingInput.partial().extend({ voiceEnabled: z.boolean().optional() });
export const decidePlanInput = z.object({ planId: id, approve: z.boolean(), reason: z.string().max(200).optional() });
export const planIdInput = z.object({ planId: id });
export const markSessionInput = z.object({ sessionId: id, status: z.enum(["done", "skipped"]) });
export const memoryIdInput = z.object({ memoryId: id });
