import { useState } from "react";
import type { StudyState } from "@studyflow/shared";
import { errorText, rpc, type AgentClient } from "../lib/agent.ts";
import { KIND_ICON, formatWhen, relative } from "../lib/format.ts";
import { notificationsSupported } from "../lib/notify.ts";

export function TodayPanel({ agent, state }: { agent: AgentClient; state: StudyState }) {
  const [error, setError] = useState("");
  const [perm, setPerm] = useState(notificationsSupported() ? Notification.permission : "denied");
  const u = state.usageToday;

  const cancel = async (reminderId: string) => {
    setError("");
    try {
      await rpc(agent, "cancelReminder", { reminderId });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="space-y-4">
      <section className="card">
        <h2 className="mb-2 text-sm font-semibold">Coming up</h2>
        {state.upcoming.length === 0 ? (
          <p className="text-sm text-muted-fg">Nothing scheduled. Ask me to “remind me tomorrow at 7pm to revise”, or create a study plan.</p>
        ) : (
          <ul className="divide-y divide-line">
            {state.upcoming.map((r) => (
              <li key={r.id} className="flex items-start gap-3 py-2 text-sm">
                <span aria-hidden>{KIND_ICON[r.kind]}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="text-xs text-muted-fg">
                    {formatWhen(r.dueAt, state.profile.timezone)} · {relative(r.dueAt)}
                  </p>
                </div>
                {r.kind === "custom" && (
                  <button className="btn" onClick={() => cancel(r.id)} aria-label={`Cancel reminder ${r.title}`}>
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="mt-2 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </section>

      {state.courses.some((c) => c.examDate) && (
        <section className="card">
          <h2 className="mb-2 text-sm font-semibold">Exams</h2>
          <ul className="space-y-1 text-sm">
            {state.courses
              .filter((c) => c.examDate)
              .map((c) => (
                <li key={c.id} className="flex justify-between">
                  <span>{c.name}</span>
                  <span className="text-muted-fg">{c.examDate}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="card text-sm">
        <h2 className="mb-2 text-sm font-semibold">Today's usage</h2>
        <dl className="grid grid-cols-2 gap-y-1 text-muted-fg">
          <dt>Messages</dt>
          <dd className="text-right text-fg">
            {u.chatTurns} / {state.caps.chatTurns}
          </dd>
          <dt>Plans started</dt>
          <dd className="text-right text-fg">
            {u.planStarts} / {state.caps.planStarts}
          </dd>
          <dt>AI tokens (in / out)</dt>
          <dd className="text-right text-fg">
            {u.inputTokens.toLocaleString()} / {u.outputTokens.toLocaleString()}
          </dd>
          {state.features.voice && (
            <>
              <dt>Voice</dt>
              <dd className="text-right text-fg">
                {u.voiceSeconds}s / {state.caps.voiceSeconds}s
              </dd>
            </>
          )}
        </dl>
      </section>

      {notificationsSupported() && perm === "default" && (
        <button className="btn w-full" onClick={() => Notification.requestPermission().then(setPerm)}>
          🔔 Enable reminder notifications
        </button>
      )}
      {perm === "denied" && <p className="text-xs text-muted-fg">Browser notifications are off. Reminders still appear in the app while it is open.</p>}
    </div>
  );
}
