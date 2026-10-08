import { createWorkersAI } from "workers-ai-provider";
import { describe, expect, it } from "vitest";
import { dedupeEvent, dedupeSse, withDedupedStreams } from "../../src/lib/ai-binding.ts";

// Event shapes captured from the real Workers AI streaming endpoint (2026-10-08): each delta appears in both the
// OpenAI form (choices[0].delta) and the native form (top-level response / tool_calls).
const text = (t: string) => ({
  choices: [{ delta: { content: t }, finish_reason: null, index: 0 }],
  response: t,
  tool_calls: [],
  usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
});
const toolName = (name: string) => ({
  choices: [{ delta: { tool_calls: [{ function: { name }, id: "call_1", index: 0, type: "function" }] }, finish_reason: null, index: 0 }],
  tool_calls: [{ name }],
});
const toolArgs = (a: string) => ({
  choices: [{ delta: { tool_calls: [{ function: { arguments: a }, index: 0 }] }, finish_reason: null, index: 0 }],
  tool_calls: [{ arguments: a }],
});
const finish = {
  choices: [{ delta: { content: "" }, finish_reason: "stop", index: 0 }],
  response: "",
  tool_calls: [],
  usage: { prompt_tokens: 1650, completion_tokens: 12, total_tokens: 1662 },
};

const sse = (events: unknown[], chunkSize = 10_000) => {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n");
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
};
const bindingFor = (events: unknown[], chunkSize?: number) => ({ run: async () => sse(events, chunkSize) }) as unknown as Ai;

async function parts(ai: Ai) {
  const model = createWorkersAI({ binding: ai })("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never);
  const out: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) out.push(r.value as Record<string, unknown>);
  return out;
}
const joined = (p: Array<Record<string, unknown>>, type: string, key: string) =>
  p
    .filter((x) => x.type === type)
    .map((x) => x[key])
    .join("");

const TEXT_EVENTS = [text("Hello"), text(" there"), finish];
const TOOL_EVENTS = [toolName("createReminder"), toolArgs('{"title": "'), toolArgs('Revise"}'), finish];

describe("workers-ai-provider with real-format streams", () => {
  it("the provider alone duplicates every delta (canary: when this fails, upstream is fixed and ai-binding.ts can go)", async () => {
    const p = await parts(bindingFor(TEXT_EVENTS));
    expect(joined(p, "text-delta", "delta")).toBe("HelloHello there there");
  });

  it("de-duplicated: text arrives once", async () => {
    const p = await parts(withDedupedStreams(bindingFor(TEXT_EVENTS)));
    expect(joined(p, "text-delta", "delta")).toBe("Hello there");
  });

  it("de-duplicated: tool-call arguments are valid JSON, once", async () => {
    const p = await parts(withDedupedStreams(bindingFor(TOOL_EVENTS)));
    const call = p.find((x) => x.type === "tool-call") as { toolName: string; input: string };
    expect(call.toolName).toBe("createReminder");
    expect(JSON.parse(call.input)).toEqual({ title: "Revise" });
    expect(joined(p, "tool-input-delta", "delta")).toBe('{"title": "Revise"}');
  });

  it("survives SSE events split across arbitrary byte boundaries", async () => {
    for (const size of [1, 7, 33, 128]) {
      const p = await parts(withDedupedStreams(bindingFor(TEXT_EVENTS, size)));
      expect(joined(p, "text-delta", "delta"), `chunk size ${size}`).toBe("Hello there");
    }
  });

  it("still reports usage from the final event", async () => {
    const p = await parts(withDedupedStreams(bindingFor(TEXT_EVENTS)));
    const fin = p.find((x) => x.type === "finish") as { usage: { inputTokens: { total: number } } };
    expect(fin.usage.inputTokens.total).toBe(1650);
  });

  it("passes non-streaming results and other binding members through untouched", async () => {
    const ai = withDedupedStreams({ run: async () => ({ response: "plain" }), models: () => "m" } as unknown as Ai);
    expect(await ai.run("x" as never, {} as never)).toEqual({ response: "plain" });
    expect((ai as unknown as { models: () => string }).models()).toBe("m");
  });
});

describe("dedupeEvent", () => {
  it("drops only the native copy and only when the OpenAI copy carries the payload", () => {
    expect(JSON.parse(dedupeEvent(JSON.stringify(text("x"))))).not.toHaveProperty("response");
    expect(JSON.parse(dedupeEvent(JSON.stringify(toolArgs("{}"))))).not.toHaveProperty("tool_calls");
    const nativeOnly = { response: "kept", choices: [{ delta: { content: "" } }] };
    expect(dedupeEvent(JSON.stringify(nativeOnly))).toBe(JSON.stringify(nativeOnly));
  });
  it("leaves malformed JSON, [DONE] and events without choices alone", () => {
    expect(dedupeEvent("{not json")).toBe("{not json");
    const usageOnly = JSON.stringify({ usage: { total_tokens: 3 }, response: "keep" });
    expect(dedupeEvent(usageOnly)).toBe(usageOnly);
  });
  it("the stream transform leaves [DONE] and blank lines intact", async () => {
    const out = await new Response(sse([text("a")]).pipeThrough(dedupeSse())).text();
    expect(out).toContain("data: [DONE]");
    expect(out).not.toContain('"response"');
  });
});
