import type { UIMessage } from "ai";
import { getToolApproval } from "@cloudflare/ai-chat/react";
import { Streamdown } from "streamdown";
import { plainText } from "../lib/format.ts";

const TOOL_LABEL: Record<string, string> = {
  remember: "Saved to memory",
  createReminder: "Reminder",
  listUpcoming: "Checked your schedule",
  cancelReminder: "Cancel reminder",
  startStudyPlan: "Study plan",
  logQuizResult: "Quiz result saved",
};

type ToolPart = {
  type: string;
  state: string;
  toolCallId: string;
  input?: Record<string, unknown>;
  output?: { ok?: boolean; error?: string; at?: string };
  errorText?: string;
};

function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(plainText(text)));
}

function ToolCard({ part, onApproval }: { part: ToolPart; onApproval: (id: string, approved: boolean) => void }) {
  const name = part.type.slice(5);
  const label = TOOL_LABEL[name] ?? name;
  if (part.state === "approval-requested") {
    const approval = getToolApproval(part as never);
    return (
      <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
        <p className="font-medium">Approve: {label}?</p>
        <p className="mt-1 break-words text-muted-fg">
          {name === "startStudyPlan"
            ? `${String(part.input?.courseName ?? "")} — exam ${String(part.input?.examDate ?? "")}, ${String(part.input?.minutesPerDay ?? "")} min/day`
            : JSON.stringify(part.input)}
        </p>
        <div className="mt-2 flex gap-2">
          <button className="btn btn-primary" onClick={() => approval && onApproval(approval.id, true)}>
            Approve
          </button>
          <button className="btn" onClick={() => approval && onApproval(approval.id, false)}>
            Deny
          </button>
        </div>
      </div>
    );
  }
  if (part.state === "output-available") {
    const failed = part.output?.ok === false;
    return (
      <p className={`text-xs ${failed ? "text-amber-600" : "text-muted-fg"}`}>
        {failed ? "⚠️" : "✓"} {label}
        {failed ? `: ${part.output?.error ?? "failed"}` : part.output?.at ? ` for ${part.output.at.replace("T", " ")}` : ""}
      </p>
    );
  }
  if (part.state === "output-error" || part.state === "output-denied")
    return (
      <p className="text-xs text-amber-600">
        ⚠️ {label}: {part.state === "output-denied" ? "denied" : (part.errorText ?? "invalid request")}
      </p>
    );
  return <p className="text-xs text-muted-fg">… {label}</p>;
}

export function MessageView({ message, onApproval }: { message: UIMessage; timezone: string; onApproval: (id: string, approved: boolean) => void }) {
  const mine = message.role === "user";
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  return (
    <article className={`flex flex-col gap-1.5 ${mine ? "items-end" : "items-start"}`} aria-label={mine ? "You" : "Studyflow"}>
      {message.parts.map((p, i) =>
        p.type === "text" ? (
          p.text && (
            <div
              key={i}
              className={`max-w-[92%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${mine ? "bg-accent text-accent-fg" : "border border-line bg-card"}`}
            >
              {mine ? (
                <p className="whitespace-pre-wrap break-words">{p.text}</p>
              ) : (
                <Streamdown className="prose-sm max-w-none break-words [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2">
                  {p.text}
                </Streamdown>
              )}
            </div>
          )
        ) : p.type.startsWith("tool-") ? (
          <ToolCard key={i} part={p as unknown as ToolPart} onApproval={onApproval} />
        ) : null,
      )}
      {!mine && text && "speechSynthesis" in window && (
        <button className="text-xs text-muted-fg hover:text-fg" onClick={() => speak(text)} aria-label="Read this message aloud">
          🔊 Read aloud
        </button>
      )}
    </article>
  );
}
