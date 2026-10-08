// Token budgeting for Llama 3.3 (24k context). Calibrated against Workers AI on 2026-10-08: a first-turn prompt of
// 4,521 characters (prose system prompt + JSON tool schemas) was 1,650 real tokens, 2.74 chars/token, while plain
// English runs about 4. 3.0 keeps the error under 15% on that JSON-heavy mix and over-estimates prose, which is the
// safe direction for a context limit.

// ponytail: a flat characters-per-token ratio instead of a tokenizer; re-measure if the prompt mix changes a lot.
export const DIVISOR = 3.0;
export const estimateTokens = (s: string) => Math.ceil(s.length / DIVISOR);

export const BUDGET = {
  system: 900, // P1
  context: 1200, // P2 incl. memory + summary
  memory: 600,
  summary: 300,
  tools: 800,
  history: 8000, // trigger for rolling summarisation
  historyAfterSummary: 4000, // what we keep verbatim after folding older turns into the summary
  userMessage: 2000,
  output: 1024,
  hardInput: 20000, // never send more than this; drop history first
} as const;

export type Sized = { tokens: number };

/**
 * Newest-first fill. Returns the index of the oldest item that fits `budget`; the last item is always kept
 * (it is the student's current message).
 */
export function fitFromEnd(items: Sized[], budget: number): number {
  let used = 0;
  let start = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    if (used + items[i].tokens > budget && start < items.length) break;
    used += items[i].tokens;
    start = i;
  }
  return start;
}

export const sumTokens = (items: Sized[]) => items.reduce((n, i) => n + i.tokens, 0);

/** Truncate text to roughly `tokens` tokens, keeping the start (used for memory/summary blocks). */
export const clipToTokens = (s: string, tokens: number) => (estimateTokens(s) <= tokens ? s : s.slice(0, Math.floor(tokens * DIVISOR) - 1) + "…");

// Workers AI pricing (2026-10-08): neurons per million tokens for Llama 3.3 70B fp8-fast, per minute for Nova-3.
export const NEURONS = { llamaIn: 26_668 / 1e6, llamaOut: 204_805 / 1e6, novaPerSecond: 836.36 / 60 } as const;
export const llamaNeurons = (input: number, output: number) => input * NEURONS.llamaIn + output * NEURONS.llamaOut;
