import { llamaNeurons, NEURONS } from "./budget.ts";
import { newId, type Sql } from "./db.ts";

// Application runtime usage (Workers AI). One row per model call; never stores message content.

export type Feature = "chat" | "summary" | "plan_extract" | "voice";
export const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const NOVA = "@cf/deepgram/nova-3";

export function recordUsage(sql: Sql, u: { feature: Feature; model: string; input?: number; output?: number; audioSeconds?: number }, now: Date): void {
  const neurons = u.audioSeconds ? u.audioSeconds * NEURONS.novaPerSecond : llamaNeurons(u.input ?? 0, u.output ?? 0);
  sql`INSERT INTO llm_usage (id, ts, feature, model, input_tokens, output_tokens, audio_seconds, neurons_est)
      VALUES (${newId()}, ${now.toISOString()}, ${u.feature}, ${u.model}, ${u.input ?? null}, ${u.output ?? null}, ${u.audioSeconds ?? null}, ${neurons})`;
}

export type UsageRow = { feature: string; model: string; calls: number; input_tokens: number; output_tokens: number; audio_seconds: number; neurons: number };

export const usageSince = (sql: Sql, sinceIso: string): UsageRow[] =>
  sql<UsageRow>`SELECT feature, model, count(*) AS calls, coalesce(sum(input_tokens),0) AS input_tokens,
      coalesce(sum(output_tokens),0) AS output_tokens, coalesce(sum(audio_seconds),0) AS audio_seconds,
      round(coalesce(sum(neurons_est),0),1) AS neurons
      FROM llm_usage WHERE ts >= ${sinceIso} GROUP BY feature, model ORDER BY feature`;
