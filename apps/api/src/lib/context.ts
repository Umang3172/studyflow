import { BUDGET, clipToTokens, estimateTokens } from "./budget.ts";
import { rankMemories, type Memory } from "./memory.ts";
import { daysBetween, utcToLocal } from "./time.ts";

// P2: the per-turn student context. Built from SQL so it is exact, compact and always inside budget.

export type ContextInput = {
  now: Date;
  timezone: string;
  displayName?: string;
  courses: Array<{ name: string; examDate?: string }>;
  plan?: { course: string; done: number; total: number; next?: { topic: string; startsAt: string } };
  upcoming: Array<{ id: string; title: string; dueAt: string }>;
  memories: Memory[];
  summary?: string;
  query: string; // the student's latest message, used to pick relevant memories
};

const line = (s: string) => s.replace(/[<>\r\n]+/g, " ").trim();

export function buildContext(i: ContextInput): string {
  const here = utcToLocal(i.now, i.timezone);
  const header = [
    `CURRENT LOCAL TIME: ${here.weekday} ${here.date} ${here.time} (${i.timezone})`,
    `NAME: ${i.displayName ? line(i.displayName) : "not given"}`,
    `COURSES: ${i.courses.length ? i.courses.map((c) => `${line(c.name)}${c.examDate ? ` (exam ${c.examDate}, in ${daysBetween(here.date, c.examDate)} days)` : ""}`).join("; ") : "none"}`,
  ];
  if (i.plan) {
    const n = i.plan.next ? utcToLocal(i.plan.next.startsAt, i.timezone) : undefined;
    header.push(
      `ACTIVE PLAN: ${line(i.plan.course)}: ${i.plan.done}/${i.plan.total} sessions done${n ? `; next: ${line(i.plan.next!.topic)} at ${n.date} ${n.time}` : ""}`,
    );
  }

  const upcoming = i.upcoming.slice(0, 5).map((u) => {
    const l = utcToLocal(u.dueAt, i.timezone);
    return `- [${u.id}] ${line(u.title)} at ${l.date} ${l.time}`;
  });

  // Most relevant memories first, within 15 rows and the memory token budget.
  const memory: string[] = [];
  let memTokens = 0;
  for (const m of rankMemories(i.memories, i.query).slice(0, 15)) {
    const row = `- [${m.kind}] ${line(m.content)}`;
    if (memTokens + estimateTokens(row) > BUDGET.memory) break;
    memTokens += estimateTokens(row);
    memory.push(row);
  }

  const build = () => {
    const parts = ["<student_context>", ...header];
    if (upcoming.length) parts.push("UPCOMING:", ...upcoming);
    if (memory.length) parts.push("MEMORY:", ...memory);
    parts.push("</student_context>");
    if (summary) parts.push(`<conversation_summary>\n${summary}\n</conversation_summary>`);
    return parts.join("\n");
  };

  const summary = i.summary ? clipToTokens(line(i.summary), BUDGET.summary) : "";
  let out = build();
  // Over budget: drop memory rows (least relevant last), then upcoming rows, never the header.
  while (estimateTokens(out) > BUDGET.context && (memory.length || upcoming.length)) {
    (memory.length ? memory : upcoming).pop();
    out = build();
  }
  return out;
}
