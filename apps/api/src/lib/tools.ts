import { tool } from "ai";
import { cancelReminderInput, createReminderInput, listUpcomingInput, logQuizInput, planToolInput, rememberInput } from "@studyflow/shared";
import type { z } from "zod";

// The six chat tools. Inputs are validated by the AI SDK against these zod schemas before execute() runs;
// execute() then validates against our data (known ids, future times, caps) and returns a small JSON result.
// Failures come back as { ok: false, error } so the model can correct itself within the step limit.

export type ToolHost = {
  remember(i: z.infer<typeof rememberInput>): unknown;
  createReminder(i: z.infer<typeof createReminderInput>): Promise<unknown>;
  listUpcoming(days: number): unknown;
  cancelReminder(id: string): Promise<unknown>;
  startStudyPlan(i: z.infer<typeof planToolInput>): Promise<unknown>;
  logQuizResult(i: z.infer<typeof logQuizInput>): unknown;
};

const MAX_RESULT_CHARS = 400;

/** Tool results are re-sent to the model every step: keep them tiny. */
export function compact(value: unknown): unknown {
  const s = JSON.stringify(value);
  return s.length <= MAX_RESULT_CHARS ? value : { ok: true, truncated: s.slice(0, MAX_RESULT_CHARS - 20) + "…" };
}

const run = async (fn: () => unknown | Promise<unknown>) => {
  try {
    return compact(await fn());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "failed" };
  }
};

export function studyTools(host: ToolHost) {
  return {
    remember: tool({
      description: "Save a durable fact about the student.",
      inputSchema: rememberInput,
      execute: (i) => run(() => host.remember(i)),
    }),
    createReminder: tool({
      description: "Set a reminder at a future local date-time (YYYY-MM-DDTHH:mm).",
      inputSchema: createReminderInput,
      execute: (i) => run(() => host.createReminder(i)),
    }),
    listUpcoming: tool({
      description: "List upcoming reminders for the next 1-30 days.",
      inputSchema: listUpcomingInput,
      execute: (i) => run(() => host.listUpcoming(i.days)),
    }),
    cancelReminder: tool({
      description: "Cancel a reminder by id (needs approval).",
      inputSchema: cancelReminderInput,
      needsApproval: true,
      execute: (i) => run(() => host.cancelReminder(i.reminderId)),
    }),
    startStudyPlan: tool({
      description: "Generate a study plan (needs approval).",
      inputSchema: planToolInput,
      needsApproval: true,
      execute: (i) => run(() => host.startStudyPlan(i)),
    }),
    logQuizResult: tool({
      description: "Record a finished quiz result.",
      inputSchema: logQuizInput,
      execute: (i) => run(() => host.logQuizResult(i)),
    }),
  };
}
