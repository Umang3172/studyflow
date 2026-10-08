import { useEffect, useState } from "react";
import { LIMITS, type StudyState } from "@studyflow/shared";
import { errorText, rpc, type AgentClient } from "../lib/agent.ts";
import { deleteAccount } from "../lib/session.ts";
import { PrivacyNote } from "../onboarding/PrivacyNote.tsx";

type UsageRow = { feature: string; model: string; calls: number; input_tokens: number; output_tokens: number; audio_seconds: number; neurons: number };

export function SettingsPanel({ agent, state }: { agent: AgentClient; state: StudyState }) {
  const p = state.profile;
  const [name, setName] = useState(p.displayName ?? "");
  const [tz, setTz] = useState(p.timezone);
  const [checkIn, setCheckIn] = useState(p.checkInTime);
  const [courses, setCourses] = useState(state.courses.map((c) => ({ name: c.name, examDate: c.examDate ?? "" })));
  const [msg, setMsg] = useState("");
  const [usage, setUsage] = useState<UsageRow[] | null>(null);

  useEffect(() => {
    rpc<{ rows: UsageRow[] }>(agent, "getUsage").then(
      (u) => setUsage(u.rows),
      () => setUsage([]),
    );
  }, [agent, state.usageToday.inputTokens]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await rpc(agent, "updateProfile", {
        displayName: name.trim() || undefined,
        timezone: tz,
        checkInTime: checkIn,
        courses: courses.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), examDate: c.examDate || undefined })),
      });
      setMsg("Saved.");
    } catch (err) {
      setMsg(errorText(err));
    }
  };
  const setCourse = (i: number, patch: Partial<{ name: string; examDate: string }>) =>
    setCourses((all) => all.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const wipe = async () => {
    if (!confirm("Delete all your Studyflow data (chat, memory, plans, reminders)? This cannot be undone.")) return;
    try {
      await deleteAccount();
      location.reload();
    } catch (err) {
      setMsg(errorText(err));
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={save} className="card space-y-3">
        <h2 className="text-sm font-semibold">Profile</h2>
        <div>
          <label className="label" htmlFor="s-name">
            Name
          </label>
          <input id="s-name" className="field" value={name} maxLength={LIMITS.displayNameChars} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="s-checkin">
              Daily check-in
            </label>
            <input id="s-checkin" type="time" className="field" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="s-tz">
              Time zone
            </label>
            <input id="s-tz" className="field" value={tz} onChange={(e) => setTz(e.target.value)} list="s-tzlist" required />
            <datalist id="s-tzlist">
              {Intl.supportedValuesOf("timeZone").map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
        </div>
        <fieldset className="space-y-2">
          <legend className="label">Courses</legend>
          {courses.map((c, i) => (
            <div key={i} className="flex gap-2">
              <input
                aria-label={`Course ${i + 1} name`}
                className="field"
                value={c.name}
                maxLength={LIMITS.courseNameChars}
                onChange={(e) => setCourse(i, { name: e.target.value })}
              />
              <input
                aria-label={`Course ${i + 1} exam date`}
                type="date"
                className="field max-w-36"
                value={c.examDate}
                onChange={(e) => setCourse(i, { examDate: e.target.value })}
              />
              <button type="button" className="btn" aria-label={`Remove course ${i + 1}`} onClick={() => setCourses((all) => all.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          {courses.length < LIMITS.courses && (
            <button type="button" className="btn" onClick={() => setCourses((all) => [...all, { name: "", examDate: "" }])}>
              + Add course
            </button>
          )}
        </fieldset>
        {state.features.voice && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.voiceEnabled}
              onChange={(e) => rpc(agent, "updateProfile", { voiceEnabled: e.target.checked }).catch((err) => setMsg(errorText(err)))}
            />
            Voice dictation (microphone button in chat)
          </label>
        )}
        <div className="flex items-center gap-3">
          <button className="btn btn-primary">Save</button>
          {msg && (
            <span className="text-xs text-muted-fg" role="status">
              {msg}
            </span>
          )}
        </div>
      </form>

      <section className="card text-sm">
        <h2 className="mb-2 font-semibold">AI usage, last 30 days</h2>
        {usage === null ? (
          <p className="text-muted-fg">Loading…</p>
        ) : usage.length === 0 ? (
          <p className="text-muted-fg">No AI calls yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-muted-fg">
              <tr>
                <th className="py-1">Feature</th>
                <th className="text-right">Calls</th>
                <th className="text-right">Tokens in/out</th>
                <th className="text-right">Neurons</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((r) => (
                <tr key={r.feature} className="border-t border-line">
                  <td className="py-1">{r.feature}</td>
                  <td className="text-right">{r.calls}</td>
                  <td className="text-right">
                    {r.audio_seconds ? `${r.audio_seconds}s audio` : `${r.input_tokens.toLocaleString()} / ${r.output_tokens.toLocaleString()}`}
                  </td>
                  <td className="text-right">{r.neurons.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-semibold">Your data</h2>
        <PrivacyNote />
        <p className="text-xs text-muted-fg">
          Everything is stored against this browser's anonymous session. Deleting removes your chat, memories, plans and reminders for good.
        </p>
        <button className="btn btn-danger" onClick={wipe}>
          Delete all my data
        </button>
      </section>
    </div>
  );
}
