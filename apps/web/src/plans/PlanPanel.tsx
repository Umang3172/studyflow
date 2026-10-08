import { useCallback, useEffect, useState } from "react";
import { LIMITS, type GanttItem, type StudyState } from "@studyflow/shared";
import { errorText, rpc, type AgentClient } from "../lib/agent.ts";
import { formatWhen } from "../lib/format.ts";
import { Gantt } from "./Gantt.tsx";

type Session = {
  id: string;
  starts_at: string;
  duration_min: number;
  kind: "learn" | "review" | "final";
  topic: string;
  objective: string | null;
  status: "pending" | "done" | "skipped";
};
type Detail = { plan: { id: string; courseName: string; examDate: string; status: string; overloaded: boolean; note: string | null }; sessions: Session[] };

const localDate = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

export function PlanPanel({ agent, state }: { agent: AgentClient; state: StudyState }) {
  const plan = state.activePlan;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const tz = state.profile.timezone;

  const reload = useCallback(() => {
    if (plan && ["awaiting_approval", "active", "completed"].includes(plan.status))
      rpc<Detail>(agent, "getPlan", { planId: plan.id }).then(setDetail, (e) => setError(errorText(e)));
    else setDetail(null);
  }, [agent, plan?.id, plan?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    reload();
  }, [reload]);

  const decide = async (approve: boolean) => {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      await rpc(agent, "decidePlan", { planId: plan.id, approve });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const mark = async (sessionId: string, status: "done" | "skipped") => {
    try {
      await rpc(agent, "markSession", { sessionId, status });
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const inFlight = plan?.status === "generating" || plan?.status === "awaiting_approval";
  const sessions = detail?.sessions ?? [];

  return (
    <div className="space-y-4">
      {plan?.status === "generating" && (
        <section className="card" aria-live="polite">
          <h2 className="mb-2 text-sm font-semibold">Building your plan…</h2>
          <div
            className="h-2 overflow-hidden rounded bg-muted"
            role="progressbar"
            aria-valuenow={Math.round((plan.progress ?? 0) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round((plan.progress ?? 0.05) * 100)}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-fg">{plan.message ?? "Working…"}</p>
        </section>
      )}

      {plan?.status === "awaiting_approval" && detail && (
        <section className="card space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Review your plan: {detail.plan.courseName}</h2>
            <p className="text-xs text-muted-fg">
              {sessions.length} sessions before the exam on {detail.plan.examDate}. Nothing is scheduled until you approve.
            </p>
          </div>
          {detail.plan.note && <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2 text-xs">{detail.plan.note}</p>}
          <Gantt items={sessions.map((s): GanttItem => ({ date: localDate(s.starts_at, tz), kind: s.kind, topic: s.topic }))} />
          <SessionList sessions={sessions} tz={tz} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>
              Approve and schedule
            </button>
            <button className="btn" disabled={busy} onClick={() => decide(false)}>
              Discard
            </button>
          </div>
          {plan.message && /Scheduling|Discarding/.test(plan.message) && (
            <p className="text-xs text-muted-fg" role="status">
              {plan.message}
            </p>
          )}
        </section>
      )}

      {plan?.status === "active" && detail && (
        <section className="card space-y-3">
          <div>
            <h2 className="text-sm font-semibold">{detail.plan.courseName}: active plan</h2>
            <p className="text-xs text-muted-fg">
              {sessions.filter((s) => s.status !== "pending").length} of {sessions.length} sessions done · exam {detail.plan.examDate}
            </p>
          </div>
          <SessionList sessions={sessions.filter((s) => s.status === "pending").slice(0, 12)} tz={tz} onMark={mark} />
        </section>
      )}

      {plan && ["failed", "rejected", "expired", "completed"].includes(plan.status) && (
        <section className={`card text-sm ${plan.status === "failed" ? "border-red-500/40" : ""}`} role="status">
          {plan.status === "completed" && "🎉 Plan completed. Nice work!"}
          {plan.status === "rejected" && "Plan discarded. No reminders were created."}
          {plan.status === "expired" && "That plan expired before it was approved."}
          {plan.status === "failed" && (
            <>
              ⚠️ {plan.message ?? "Plan generation failed."} <span className="text-muted-fg">You can try again below.</span>
            </>
          )}
        </section>
      )}

      {!inFlight && (plan?.status !== "active" || showForm) && <PlanForm agent={agent} state={state} onError={setError} />}
      {plan?.status === "active" && !showForm && (
        <button className="btn w-full" onClick={() => setShowForm(true)}>
          Replace with a new plan
        </button>
      )}
      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SessionList({ sessions, tz, onMark }: { sessions: Session[]; tz: string; onMark?: (id: string, s: "done" | "skipped") => void }) {
  return (
    <ul className="max-h-72 divide-y divide-line overflow-y-auto text-sm" tabIndex={0} aria-label="Study sessions">
      {sessions.map((s) => (
        <li key={s.id} className="flex items-start gap-2 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate">
              <span className="mr-1 text-xs uppercase text-muted-fg">{s.kind}</span>
              {s.topic}
            </p>
            <p className="text-xs text-muted-fg">
              {formatWhen(s.starts_at, tz)} · {s.duration_min} min
            </p>
          </div>
          {onMark && (
            <div className="flex gap-1">
              <button className="btn" onClick={() => onMark(s.id, "done")} aria-label={`Mark done: ${s.topic}`}>
                ✓
              </button>
              <button className="btn" onClick={() => onMark(s.id, "skipped")} aria-label={`Skip: ${s.topic}`}>
                Skip
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function PlanForm({ agent, state, onError }: { agent: AgentClient; state: StudyState; onError: (m: string) => void }) {
  const first = state.courses[0];
  const [courseName, setCourseName] = useState(first?.name ?? "");
  const [examDate, setExamDate] = useState(first?.examDate ?? "");
  const [material, setMaterial] = useState("");
  const [minutesPerDay, setMinutes] = useState(90);
  const [sessionMinutes, setSession] = useState(45);
  const [preferredTime, setTime] = useState("19:00");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onError("");
    try {
      await rpc(agent, "startPlan", { courseName, examDate, material, minutesPerDay, sessionMinutes, preferredTime });
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const capped = state.usageToday.planStarts >= state.caps.planStarts;

  return (
    <form onSubmit={submit} className="card space-y-3">
      <h2 className="text-sm font-semibold">New study plan</h2>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <label className="label" htmlFor="p-course">
            Course
          </label>
          <input
            id="p-course"
            className="field"
            list="p-courses"
            value={courseName}
            maxLength={LIMITS.courseNameChars}
            onChange={(e) => {
              setCourseName(e.target.value);
              const match = state.courses.find((c) => c.name === e.target.value);
              if (match?.examDate) setExamDate(match.examDate);
            }}
            required
          />
          <datalist id="p-courses">
            {state.courses.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="label" htmlFor="p-exam">
            Exam date
          </label>
          <input id="p-exam" type="date" className="field" value={examDate} onChange={(e) => setExamDate(e.target.value)} required />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="p-material">
          Topics or syllabus (paste text)
        </label>
        <textarea
          id="p-material"
          className="field min-h-32"
          value={material}
          maxLength={LIMITS.materialChars}
          onChange={(e) => setMaterial(e.target.value)}
          required
          placeholder={"Process scheduling\nDeadlocks\nPaging and virtual memory\n…"}
        />
        <p className="mt-1 text-right text-xs text-muted-fg">
          {material.length.toLocaleString()} / {LIMITS.materialChars.toLocaleString()}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="label" htmlFor="p-min">
            Minutes/day
          </label>
          <input id="p-min" type="number" className="field" min={30} max={240} step={15} value={minutesPerDay} onChange={(e) => setMinutes(+e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="p-sess">
            Session (min)
          </label>
          <input id="p-sess" type="number" className="field" min={25} max={90} step={5} value={sessionMinutes} onChange={(e) => setSession(+e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="p-time">
            Start time
          </label>
          <input id="p-time" type="time" className="field" value={preferredTime} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-primary w-full" disabled={busy || capped}>
        {capped ? "Daily plan limit reached" : busy ? "Starting…" : "Generate plan"}
      </button>
    </form>
  );
}
