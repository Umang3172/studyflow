import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { withDedupedStreams } from "./ai-binding.ts";
import { createMockModel } from "./mock-model.ts";
import { LLAMA } from "./usage.ts";

/** Llama 3.3 on Workers AI, or the deterministic mock when MOCK_AI=1 (never set in production). */
// ponytail: the mock model is bundled in production (a few KB); gate it behind a build flag if size ever matters.
export function chatModel(env: Cloudflare.Env, sessionAffinity?: string): LanguageModel {
  if (env.MOCK_AI === "1") return createMockModel();
  return createWorkersAI({ binding: withDedupedStreams(env.AI) })(LLAMA, { sessionAffinity });
}
