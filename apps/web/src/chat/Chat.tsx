import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useEffect, useRef } from "react";
import type { StudyState } from "@studyflow/shared";
import type { AgentClient } from "../lib/agent.ts";
import { Composer } from "./Composer.tsx";
import { MessageView } from "./MessageView.tsx";

const STARTERS = ["Quiz me on my weakest topic", "Explain this to me step by step: ", "Remind me tomorrow at 7pm to revise", "What's coming up this week?"];

export function Chat({ agent, state }: { agent: AgentClient; state: StudyState }) {
  const { messages, sendMessage, status, error, clearHistory, addToolApprovalResponse, stop, isStreaming } = useAgentChat({ agent });
  const end = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming" || isStreaming;
  const capped = state.usageToday.chatTurns >= state.caps.chatTurns;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" role="log" aria-live="polite" aria-label="Conversation">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.length === 0 && (
            <div className="card text-sm text-muted-fg">
              <p className="mb-3 font-medium text-fg">Ask anything about your courses, or try:</p>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button key={s} className="btn" onClick={() => (s.endsWith(": ") ? undefined : sendMessage({ text: s }))} disabled={busy || s.endsWith(": ")}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <MessageView key={m.id} message={m} timezone={state.profile.timezone} onApproval={(id, approved) => addToolApprovalResponse({ id, approved })} />
          ))}
          {busy && <p className="text-xs text-muted-fg">Thinking…</p>}
          {error && (
            <p className="rounded-lg border border-red-500/40 p-3 text-sm text-red-600" role="alert">
              Something went wrong. {error.message.slice(0, 160)}
            </p>
          )}
          <div ref={end} />
        </div>
      </div>
      <div className="border-t border-line bg-card px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {capped && <p className="mb-2 text-xs text-amber-600">You've used today's messages. Reminders and plans keep working.</p>}
          <Composer
            busy={busy}
            disabled={capped}
            voice={state.features.voice && state.profile.voiceEnabled}
            onSend={(text) => sendMessage({ text })}
            onStop={stop}
            onClear={messages.length ? clearHistory : undefined}
          />
        </div>
      </div>
    </>
  );
}
