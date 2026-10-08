import { useAgent } from "agents/react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { initialStudyState, type StudyState } from "@studyflow/shared";
import { Chat } from "./chat/Chat.tsx";
import { MemoryPanel } from "./memory/MemoryPanel.tsx";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { PlanPanel } from "./plans/PlanPanel.tsx";
import { SettingsPanel } from "./settings/SettingsPanel.tsx";
import { TodayPanel } from "./today/TodayPanel.tsx";
import { ensureSession } from "./lib/session.ts";
import { parseReminder, systemNotify, type Toast } from "./lib/notify.ts";

type Tab = "chat" | "today" | "plan" | "memory" | "settings";
const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "today", label: "Today", icon: "📅" },
  { id: "plan", label: "Plan", icon: "🗺️" },
  { id: "memory", label: "Memory", icon: "🧠" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

const Splash = ({ text }: { text: string }) => (
  <div className="grid h-full place-items-center p-6 text-center text-muted-fg" role="status">
    {text}
  </div>
);

export default function App() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const start = useCallback(() => {
    setPhase("loading");
    ensureSession().then(
      () => setPhase("ready"),
      (e: Error) => (setError(e.message), setPhase("error")),
    );
  }, []);
  useEffect(() => {
    start();
  }, [start]);

  if (phase === "loading") return <Splash text="Starting Studyflow…" />;
  if (phase === "error") {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="mb-3">{error}</p>
          <button className="btn btn-primary" onClick={start}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <Studyflow />;
}

function Studyflow() {
  const [state, setState] = useState<StudyState>(initialStudyState);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [tab, setTab] = useState<Tab>("chat");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef(new Set<string>());

  const toast = useCallback((t: Omit<Toast, "key">) => {
    const key = crypto.randomUUID();
    setToasts((all) => [...all, { ...t, key }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.key !== key)), 12000);
  }, []);

  // The instance is chosen by the server from the session cookie; `agent` is ignored when basePath is set.
  const agent = useAgent<StudyState>({
    agent: "StudyAgent",
    basePath: "agents/study",
    onStateUpdate: (s) => (setState(s), setLoaded(true)),
    onOpen: () => setOnline(true),
    onClose: () => setOnline(false),
    onMessage: (e) => {
      const r = parseReminder(e.data);
      // Several tabs receive the same event; dedupe per reminder id within this tab.
      if (!r || seen.current.has(r.id)) return;
      seen.current.add(r.id);
      toast({ title: r.title, body: r.body });
      systemNotify(r);
    },
  });

  if (!loaded) return <Splash text="Connecting…" />;
  if (!state.profile.onboarded) return <Onboarding agent={agent} />;

  const panel = tab === "chat" ? "today" : tab;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line bg-card px-4 py-2">
        <h1 className="text-base font-semibold">
          Studyflow
          <span className="ml-2 hidden text-xs font-normal text-muted-fg sm:inline">
            {state.profile.displayName ? `Hi, ${state.profile.displayName}` : "study coach"}
          </span>
        </h1>
        <span className={`text-xs ${online ? "text-muted-fg" : "text-amber-600"}`} role="status">
          {online ? `${state.usageToday.chatTurns}/${state.caps.chatTurns} messages today` : "Reconnecting…"}
        </span>
      </header>

      <main className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_400px]">
        <section className={`${tab === "chat" ? "flex" : "hidden md:flex"} min-h-0 flex-col`} aria-label="Chat">
          {/* Suspense sits below useAgent: useAgentChat suspends while it fetches history, and suspending above
              the connection hook would tear down (and re-create) the socket's effects. */}
          <Suspense fallback={<Splash text="Loading your conversation…" />}>
            <Chat agent={agent} state={state} />
          </Suspense>
        </section>
        <aside className={`${tab === "chat" ? "hidden md:block" : "block"} min-h-0 overflow-y-auto border-line bg-muted/40 p-4 md:border-l`} aria-label={panel}>
          <nav className="mb-4 hidden gap-1 md:flex" aria-label="Panels">
            {TABS.filter((t) => t.id !== "chat").map((t) => (
              <button key={t.id} className={`btn ${panel === t.id ? "btn-primary" : ""}`} aria-pressed={panel === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          {panel === "today" && <TodayPanel agent={agent} state={state} />}
          {panel === "plan" && <PlanPanel agent={agent} state={state} />}
          {panel === "memory" && <MemoryPanel agent={agent} />}
          {panel === "settings" && <SettingsPanel agent={agent} state={state} />}
        </aside>
      </main>

      <nav className="grid grid-cols-5 border-t border-line bg-card md:hidden" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`flex flex-col items-center gap-0.5 py-2 text-xs ${tab === t.id ? "font-semibold text-accent" : "text-muted-fg"}`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            <span aria-hidden>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.key} className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border border-line bg-card px-4 py-3 shadow-lg">
            <span aria-hidden>⏰</span>
            <div className="min-w-0 text-sm">
              <p className="font-medium">{t.title}</p>
              {t.body && <p className="text-muted-fg">{t.body}</p>}
            </div>
            <button className="text-muted-fg" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.key !== t.key))}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
