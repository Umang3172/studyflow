import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";

// Deterministic stand-in for Llama 3.3, used only when MOCK_AI=1 (tests, Playwright, offline demos).
// It reads the latest student message and either streams a canned answer or emits one tool call,
// so the real tool/validation/approval paths run without touching Workers AI.

type Prompt = Parameters<LanguageModelV4["doStream"]>[0]["prompt"];

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role === "user") return m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
  }
  return "";
}

const promptChars = (prompt: Prompt) => JSON.stringify(prompt).length;

/** What the mock does for a message. Exported so tests can assert the routing. */
export function mockPlan(text: string): { tool?: { name: string; input: unknown }; reply: string } {
  const t = text.toLowerCase();
  const remind = /remind me (?:at|on|tomorrow)?.*?(\d{4}-\d{2}-\d{2}t\d{2}:\d{2})\s*(?:to|:)?\s*(.*)/i.exec(text);
  if (remind)
    return {
      tool: { name: "createReminder", input: { title: remind[2]?.trim() || "Study", localDateTime: remind[1].toUpperCase().replace("T", "T") } },
      reply: "Reminder set.",
    };
  const plan = /make me a plan for (.+?) exam (\d{4}-\d{2}-\d{2})/i.exec(text);
  if (plan) return { tool: { name: "startStudyPlan", input: { courseName: plan[1], examDate: plan[2], minutesPerDay: 90 } }, reply: "Plan started." };
  if (t.includes("remember"))
    return {
      tool: { name: "remember", input: { kind: "preference", content: text.replace(/.*remember( that)?/i, "").trim() || "likes examples" } },
      reply: "Noted.",
    };
  if (t.includes("what's coming") || t.includes("upcoming")) return { tool: { name: "listUpcoming", input: { days: 7 } }, reply: "Here is what is coming up." };
  if (t.includes("bad reminder")) return { tool: { name: "createReminder", input: { title: "x", localDateTime: "tomorrow 9am" } }, reply: "Tried." };
  return { reply: `Mock coach: let's work on "${text.slice(0, 60)}". First hint: break it into smaller parts. What have you tried so far?` };
}

export function createMockModel(): LanguageModelV4 {
  const model = {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-llama",
    supportedUrls: {},
    async doGenerate(options: Parameters<LanguageModelV4["doGenerate"]>[0]) {
      const system = JSON.stringify(options.prompt);
      // Summariser / extractor calls come through generateText; answer with fixed, valid output.
      const text = system.includes("running summary")
        ? "Mock summary: the student studied recent topics and asked follow-up questions."
        : system.includes("study topic list")
          ? JSON.stringify({ topics: topicsFrom(system) })
          : "ok";
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: usage(Math.ceil(promptChars(options.prompt) / 3.5), Math.ceil(text.length / 3.5)),
        warnings: [],
      };
    },
    async doStream(options: Parameters<LanguageModelV4["doStream"]>[0]) {
      const lastIsToolResult = options.prompt[options.prompt.length - 1]?.role === "tool";
      const plan = mockPlan(lastUserText(options.prompt));
      const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      const input = Math.ceil(promptChars(options.prompt) / 3.5);
      if (plan.tool && !lastIsToolResult) {
        chunks.push(
          { type: "tool-call", toolCallId: `mock${Date.now().toString(36)}`, toolName: plan.tool.name, input: JSON.stringify(plan.tool.input) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage(input, 20) },
        );
      } else {
        const reply = lastIsToolResult ? "Done. Anything else I can help with?" : plan.reply;
        chunks.push({ type: "text-start", id: "t1" });
        for (const word of reply.split(/(?<= )/)) chunks.push({ type: "text-delta", id: "t1", delta: word });
        chunks.push(
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(input, Math.ceil(reply.length / 3.5)) },
        );
      }
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          for (const c of chunks) {
            controller.enqueue(c);
            await new Promise((r) => setTimeout(r, 15));
          }
          controller.close();
        },
      });
      return { stream };
    },
  };
  return model as unknown as LanguageModelV4;
}

/** Topics for the plan workflow: one per non-empty line of the material, difficulty cycling 1..3. */
function topicsFrom(promptJson: string): Array<{ title: string; difficulty: number; objective: string }> {
  const m = /<student_material>\\n([\s\S]*?)\\n<\/student_material>/.exec(promptJson);
  const lines = (m?.[1] ?? "")
    .split("\\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim())
    .filter((l) => l.length > 2);
  return lines.slice(0, 30).map((title, i) => ({ title: title.slice(0, 80), difficulty: (i % 3) + 1, objective: `Understand ${title.slice(0, 60)}` }));
}
