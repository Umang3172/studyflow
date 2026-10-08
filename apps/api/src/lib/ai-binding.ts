// ponytail: workaround for workers-ai-provider@4.0.0. Every Workers AI streaming event currently carries each delta
// twice, in OpenAI form (`choices[0].delta.content|tool_calls`) AND native form (`response`, top-level `tool_calls`),
// and the provider handles both blocks, so every token and tool-call fragment is emitted twice ("you you're're",
// corrupted tool JSON). This strips the native copy when the OpenAI copy carries the payload. Remove it when
// test/unit/ai-binding.test.ts ("the provider alone duplicates") starts failing, which means upstream fixed it.

type Delta = { content?: unknown; tool_calls?: unknown };
type Event = { choices?: Array<{ delta?: Delta }>; response?: unknown; tool_calls?: unknown };

/** Remove the native duplicate fields from one SSE `data:` JSON payload. Returns the input unchanged if nothing applies. */
export function dedupeEvent(json: string): string {
  let event: Event;
  try {
    event = JSON.parse(json);
  } catch {
    return json;
  }
  const delta = event.choices?.[0]?.delta;
  if (!delta) return json;
  let changed = false;
  if (typeof delta.content === "string" && delta.content !== "" && "response" in event) {
    delete event.response;
    changed = true;
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0 && "tool_calls" in event) {
    delete event.tool_calls;
    changed = true;
  }
  // An event whose OpenAI delta is empty but whose native `response` is "" carries nothing either way, so leave it alone.
  return changed ? JSON.stringify(event) : json;
}

/** TransformStream over raw SSE bytes that applies dedupeEvent to each `data:` line. */
export function dedupeSse(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const fix = (line: string) => (line.startsWith("data: ") && line !== "data: [DONE]" ? `data: ${dedupeEvent(line.slice(6))}` : line);
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length) controller.enqueue(encoder.encode(lines.map((l) => `${fix(l)}\n`).join("")));
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(fix(buffer)));
    },
  });
}

/** Wrap an `Ai` binding so streaming `run()` results are de-duplicated; everything else passes through. */
export function withDedupedStreams(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop) {
      if (prop === "run") {
        return async (...args: Parameters<Ai["run"]>) => {
          const out = await (target.run as (...a: unknown[]) => Promise<unknown>)(...args);
          return out instanceof ReadableStream ? out.pipeThrough(dedupeSse()) : out;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
