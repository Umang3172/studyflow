import { useState } from "react";
import { LIMITS } from "@studyflow/shared";
import { errorText, rpc, type AgentClient } from "../lib/agent.ts";
import { browserTimezone } from "../lib/format.ts";
import { PrivacyNote } from "./PrivacyNote.tsx";

type Course = { name: string; examDate: string };

export function Onboarding({ agent }: { agent: AgentClient }) {
  const [name, setName] = useState("");
  const [checkIn, setCheckIn] = useState("08:00");
  const [timezone, setTimezone] = useState(browserTimezone());
  const [courses, setCourses] = useState<Course[]>([{ name: "", examDate: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await rpc(agent, "completeOnboarding", {
        displayName: name.trim() || undefined,
        timezone,
        checkInTime: checkIn,
        courses: courses.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), examDate: c.examDate || undefined })),
      });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  const set = (i: number, patch: Partial<Course>) => setCourses((all) => all.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <main className="mx-auto flex min-h-full max-w-xl items-center p-4">
      <form onSubmit={submit} className="card w-full space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Welcome to Studyflow</h1>
          <p className="mt-1 text-sm text-muted-fg">
            Your exam sprint coach: plans, reminders, quizzes and memory of what you find hard. No account needed; your data lives with this browser, so
            clearing site data loses it.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="name">
            What should I call you? (optional)
          </label>
          <input
            id="name"
            className="field"
            value={name}
            maxLength={LIMITS.displayNameChars}
            onChange={(e) => setName(e.target.value)}
            placeholder="First name or nickname"
            autoComplete="off"
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="label">Your courses and exam dates (optional)</legend>
          {courses.map((c, i) => (
            <div key={i} className="flex gap-2">
              <input
                aria-label={`Course ${i + 1} name`}
                className="field"
                value={c.name}
                maxLength={LIMITS.courseNameChars}
                onChange={(e) => set(i, { name: e.target.value })}
                placeholder="e.g. Operating Systems"
              />
              <input
                aria-label={`Course ${i + 1} exam date`}
                type="date"
                className="field max-w-40"
                value={c.examDate}
                onChange={(e) => set(i, { examDate: e.target.value })}
              />
            </div>
          ))}
          {courses.length < LIMITS.courses && (
            <button type="button" className="btn" onClick={() => setCourses((all) => [...all, { name: "", examDate: "" }])}>
              + Add course
            </button>
          )}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="checkin">
              Daily check-in time
            </label>
            <input id="checkin" type="time" className="field" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="tz">
              Time zone
            </label>
            <input id="tz" className="field" value={timezone} onChange={(e) => setTimezone(e.target.value)} list="tzlist" required />
            <datalist id="tzlist">
              {Intl.supportedValuesOf("timeZone").map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
        </div>
        <PrivacyNote />
        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Setting up…" : "Start studying"}
        </button>
      </form>
    </main>
  );
}
