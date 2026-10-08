import { useCallback, useEffect, useState } from "react";
import { errorText, rpc, type AgentClient } from "../lib/agent.ts";

type Row = { id: string; kind: string; content: string; updated_at: string };
const KIND: Record<string, string> = { goal: "🎯 Goal", weak_topic: "⚠️ Needs work", strength: "💪 Strength", preference: "🙂 Preference", fact: "📝 Note" };

export function MemoryPanel({ agent }: { agent: AgentClient }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => rpc<Row[]>(agent, "listMemoryRows").then(setRows, (e) => setError(errorText(e))), [agent]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 15000); // picks up memories saved during chat
    return () => clearInterval(t);
  }, [load]);

  const remove = async (memoryId: string) => {
    try {
      await rpc(agent, "deleteMemory", { memoryId });
      setRows((r) => r?.filter((x) => x.id !== memoryId) ?? r);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold">What I remember about you</h2>
      <p className="mb-3 text-xs text-muted-fg">Saved from your chats so I can personalise help. Delete anything you don't want kept.</p>
      {rows === null ? (
        <p className="text-sm text-muted-fg">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-fg">Nothing yet. Tell me your goals or what you find hard.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((m) => (
            <li key={m.id} className="flex items-start gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-fg">{KIND[m.kind] ?? m.kind}</p>
                <p className="break-words">{m.content}</p>
              </div>
              <button className="btn" onClick={() => remove(m.id)} aria-label={`Forget: ${m.content}`}>
                Forget
              </button>
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
  );
}
