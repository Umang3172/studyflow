import { jsonSchema, tool } from "ai";
import { cancelReminderInput, createReminderInput, listUpcomingInput, logQuizInput, planToolInput, rememberInput } from "@studyflow/shared";
import { z } from "zod";

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

// Keywords that only matter for validation. The server still enforces them (zod runs on every call); the model does
// not need to read them on every step, and they were a third of the tool-schema tokens.
const VALIDATION_ONLY = new Set(["$schema", "additionalProperties", "pattern", "minLength", "maxLength", "minimum", "maximum", "default", "format"]);
export function slim(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slim);
  if (node && typeof node === "object")
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => !VALIDATION_ONLY.has(k))
        .map(([k, v]) => [k, slim(v)]),
    );
  return node;
}

/** Slim JSON schema for the model, full zod validation for the server. */
export function modelSchema<S extends z.ZodType>(schema: S) {
  return jsonSchema<z.infer<S>>(slim(z.toJSONSchema(schema, { io: "input" })) as never, {
    validate: (value) => {
      const r = schema.safeParse(value);
      return r.success
        ? { success: true, value: r.data }
        : { success: false, error: new Error(`${r.error.issues[0].path.join(".")}: ${r.error.issues[0].message}`) };
    },
  });
}

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
      description:
        "Save a goal, preference, strength or weak topic the student states about themselves. At most 2 per turn. Never passwords, health or money details.",
      inputSchema: modelSchema(rememberInput),
      execute: (i) => run(() => host.remember(i)),
    }),
    createReminder: tool({
      description:
        "Set a reminder only when the student gave both what and when. localDateTime is local YYYY-MM-DDTHH:mm in the future (use CURRENT LOCAL TIME); when quotes their time words. If no time was given or it has passed, ask the student instead and never guess.",
      inputSchema: modelSchema(createReminderInput),
      execute: (i) => run(() => host.createReminder(i)),
    }),
    listUpcoming: tool({
      description: "List upcoming reminders for the next 1-30 days.",
      inputSchema: modelSchema(listUpcomingInput),
      execute: (i) => run(() => host.listUpcoming(i.days)),
    }),
    cancelReminder: tool({
      description: "Cancel a reminder by an id from STUDENT CONTEXT (needs approval).",
      inputSchema: modelSchema(cancelReminderInput),
      needsApproval: true,
      execute: (i) => run(() => host.cancelReminder(i.reminderId)),
    }),
    startStudyPlan: tool({
      description:
        "Generate a study plan (needs approval). Needs course, exam date and minutes per day; a pasted syllabus is read automatically. Ask for anything missing.",
      inputSchema: modelSchema(planToolInput),
      needsApproval: true,
      execute: (i) => run(() => host.startStudyPlan(i)),
    }),
    logQuizResult: tool({
      description: "Record a finished quiz. Call it once, only after the student has answered every question.",
      inputSchema: modelSchema(logQuizInput),
      execute: (i) => run(() => host.logQuizResult(i)),
    }),
  };
}

export type ToolName = keyof ReturnType<typeof studyTools>;

// Which tools does this conversation need? Tool definitions are re-sent on every model step (about 1,100 tokens for
// all six), and with nothing to act on, Llama 3.3 sometimes writes a tool call into its answer as plain text. So tools
// are only offered when recent messages look like a request for them. Keywords are broad on purpose: a miss means the
// model answers in words and the student rephrases.
// ponytail: regex intent routing; upgrade to a small classifier call if misses show up in the evals.
const INTENT: Record<ToolName, RegExp> = {
  remember:
    /\b(remember|my goal|goal is|i want to|i need to|i'm|i am|i always|i keep|i tend|i struggle|i find|i prefer|prefer|i like|i learn|weak|strong|struggl\w*|confus\w*|good at|bad at)\b/i,
  createReminder: /\b(remind\w*|alarm|alert|notify|nudge|ping|wake me|tell me (at|when|on))\b/i,
  listUpcoming: /\b(coming up|upcoming|schedule|agenda|what's|what is|what do i have|reminders?|this week|next week|due|deadline|today|tomorrow|tonight)\b/i,
  cancelReminder: /\b(cancel\w*|remove|delete|drop|clear)\b/i,
  startStudyPlan: /\b(study plan|plan|syllabus|timetable|revision schedule|exam)\b/i,
  logQuizResult: /\b(quiz\w*|test me|score)\b/i,
};

/** Tools to offer for this turn: intent matches in the recent messages, plus any tool already used in the last reply
 * (a pending approval must still resolve to its tool). */
export function toolsFor(recentText: string, used: readonly string[]): ToolName[] {
  return (Object.keys(INTENT) as ToolName[]).filter((name) => INTENT[name].test(recentText) || used.includes(name));
}
