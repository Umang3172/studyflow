import type { UIMessage } from "ai";
import { BUDGET, clipToTokens, estimateTokens, fitFromEnd, sumTokens } from "./budget.ts";

// Rolling summary: the model sees [summary of older turns] + [newest turns that fit the history budget].
// When the verbatim turns outgrow BUDGET.history, the oldest ones are folded into the summary in ONE
// summariser call, leaving about BUDGET.historyAfterSummary verbatim. That hysteresis means one extra
// call every ~4k tokens of new conversation instead of one per turn.

export type Summary = { text: string; uptoId: string | null };
export type Summarizer = (previous: string, transcript: string) => Promise<string>;

const TOOL_RESULT_CHARS = 160;
const TRANSCRIPT_MESSAGE_CHARS = 400;
// ponytail: only the newest 30 folded messages are sent to the summariser; older ones in a huge backlog are dropped, raise if needed.
const TRANSCRIPT_MAX_MESSAGES = 30;
const SUMMARY_MAX_CHARS = 900;

type Part = { type: string; text?: string; state?: string; output?: unknown; input?: unknown };

/** Plain text of a message, with tool calls reduced to a one-line marker. */
export function messageText(m: UIMessage): string {
  return (m.parts as Part[])
    .map((p) => {
      if (p.type === "text") return p.text ?? "";
      if (p.type.startsWith("tool-") && p.state === "output-available") {
        return `[${p.type.slice(5)} -> ${JSON.stringify(p.output).slice(0, TOOL_RESULT_CHARS)}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** Conservative size: model-visible text plus tool payloads. */
export const messageTokens = (m: UIMessage) =>
  estimateTokens(JSON.stringify((m.parts as Part[]).filter((p) => p.type === "text" || p.type.startsWith("tool-")))) + 4;

/** Deterministic fallback when the summariser fails: keep the tail of (previous + one line per student message). */
export function extractiveSummary(previous: string, evicted: UIMessage[]): string {
  const lines = evicted.filter((m) => m.role === "user").map((m) => `Asked: ${messageText(m).slice(0, 100)}`);
  return `${previous} ${lines.join(" ")}`.trim().slice(-SUMMARY_MAX_CHARS);
}

export type HistoryPlan = { kept: UIMessage[]; summary: Summary; folded: UIMessage[] };

export async function planHistory(messages: UIMessage[], summary: Summary, summarize: Summarizer): Promise<HistoryPlan> {
  const at = summary.uptoId ? messages.findIndex((m) => m.id === summary.uptoId) : -1;
  const live = messages.slice(at + 1); // not yet covered by the summary
  const sized = live.map((m) => ({ m, tokens: messageTokens(m) }));
  if (sumTokens(sized) <= BUDGET.history) return { kept: live, summary, folded: [] };

  let keepFrom = fitFromEnd(sized, BUDGET.historyAfterSummary);
  while (keepFrom < live.length - 1 && live[keepFrom].role !== "user") keepFrom++; // start on a student turn
  const evicted = live.slice(0, keepFrom);
  if (!evicted.length) return { kept: live, summary, folded: [] };

  const transcript = evicted
    .slice(-TRANSCRIPT_MAX_MESSAGES)
    .map((m) => `${m.role === "user" ? "Student" : "Coach"}: ${messageText(m).slice(0, TRANSCRIPT_MESSAGE_CHARS)}`)
    .join("\n");
  let text: string;
  try {
    text = (await summarize(summary.text, transcript)).trim();
    if (!text) throw new Error("empty summary");
  } catch {
    text = extractiveSummary(summary.text, evicted);
  }
  return {
    kept: live.slice(keepFrom),
    summary: { text: clipToTokens(text, BUDGET.summary), uptoId: evicted[evicted.length - 1].id },
    folded: evicted,
  };
}

/** Last-resort guard: drop the oldest verbatim turns until the whole prompt estimate fits `limit`. */
export function dropToFit(kept: UIMessage[], fixedTokens: number, limit: number): UIMessage[] {
  let out = kept;
  while (out.length > 1 && fixedTokens + sumTokens(out.map((m) => ({ tokens: messageTokens(m) }))) > limit) out = out.slice(1);
  while (out.length > 1 && out[0].role !== "user") out = out.slice(1);
  return out;
}
