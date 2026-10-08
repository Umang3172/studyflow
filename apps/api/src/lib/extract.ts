import { generateText, type LanguageModel } from "ai";
import { LIMITS, topicsOutput, type Topic } from "@studyflow/shared";
import { EXTRACT_SYSTEM, extractPrompt, repairPrompt } from "./prompts.ts";

// P3: one LLM call per plan (plus at most one repair). Output is untrusted: parse, validate, clamp.

export class NoTopicsError extends Error {}
export type Usage = { input: number; output: number };

/** Pull the JSON object out of a model reply that may include prose or code fences. */
export function parseTopics(text: string): Topic[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in output");
  return topicsOutput.parse(JSON.parse(text.slice(start, end + 1))).topics;
}

export async function extractTopics(
  model: LanguageModel,
  p: { courseName: string; examDate: string; material: string },
): Promise<{ topics: Topic[]; usage: Usage }> {
  const usage: Usage = { input: 0, output: 0 };
  const add = (u: { inputTokens?: number; outputTokens?: number }) => {
    usage.input += u.inputTokens ?? 0;
    usage.output += u.outputTokens ?? 0;
  };
  const user = extractPrompt(p.courseName, p.examDate, p.material);
  const call = { model, system: EXTRACT_SYSTEM, temperature: 0.2, maxOutputTokens: 1500 } as const;

  const first = await generateText({ ...call, prompt: user });
  add(first.usage);
  let topics: Topic[];
  try {
    topics = parseTopics(first.text);
  } catch (e) {
    const repair = await generateText({
      ...call,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: first.text.slice(0, 3000) },
        { role: "user", content: repairPrompt(e instanceof Error ? e.message : "invalid") },
      ],
    });
    add(repair.usage);
    topics = parseTopics(repair.text); // a second failure throws and the step retries
  }
  if (topics.length < LIMITS.topicsMin) throw new NoTopicsError("I could not find enough study topics in that text. Paste a fuller syllabus or topic list.");
  return { topics, usage };
}
