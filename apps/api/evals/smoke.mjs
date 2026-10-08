#!/usr/bin/env node
// Smoke test for a deployed Studyflow (real Workers AI). Creates a throwaway anonymous student, checks the whole
// chain, then deletes the student.
//
//   node apps/api/evals/smoke.mjs https://studyflow-1ir.pages.dev
//
// Checks: health, session cookie, WebSocket state sync through Pages, a streamed reply with no doubled words,
// a reminder for "in 2 minutes" that really fires, the study-plan workflow with the real model through approval,
// and account deletion. Takes about 3 minutes. Needs Node 22+ (global WebSocket with header support).

const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:8787";
const url = new URL(BASE);
const ORIGIN = process.env.SMOKE_ORIGIN ?? (url.hostname === "localhost" ? "http://localhost:5173" : url.origin);
const results = [];
const check = (name, ok, note = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  ${note}` : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
check("health endpoint", health.ok === true, `version ${health.version}`);

const session = await fetch(`${BASE}/api/session`);
const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0];
check("session cookie issued", cookie.startsWith("sf_session="));

const ws = new WebSocket(BASE.replace("http", "ws") + "/agents/study", { headers: { cookie, origin: ORIGIN } });
const frames = [];
ws.addEventListener("message", (e) => {
  try {
    frames.push(JSON.parse(String(e.data)));
  } catch {
    /* binary */
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", () => reject(new Error("websocket failed to open")));
});
const waitFor = async (pred, ms = 60_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = frames.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return undefined;
};
const state = () => [...frames].reverse().find((f) => f.type === "cf_agent_state")?.state;
const call = async (method, ...args) => {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({ type: "rpc", id, method, args }));
  const f = await waitFor((x) => x.type === "rpc" && x.id === id, 30_000);
  if (!f?.success) throw new Error(f?.error ?? `${method} timed out`);
  return f.result;
};
const chat = async (text) => {
  const id = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id,
      init: { method: "POST", body: JSON.stringify({ messages: [{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }] }) },
    }),
  );
  await waitFor((f) => f.type === "cf_agent_use_chat_response" && f.id === id && f.done, 90_000);
  const chunks = frames.filter((f) => f.type === "cf_agent_use_chat_response" && f.id === id && f.body).map((f) => JSON.parse(f.body));
  return {
    text: chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join(""),
    tools: chunks.filter((c) => c.type === "tool-input-available").map((c) => c.toolName),
  };
};

try {
  check("state syncs over the WebSocket", !!(await waitFor((f) => f.type === "cf_agent_state", 15_000)));
  await call("completeOnboarding", { timezone: "UTC", checkInTime: "08:00", courses: [] });

  const hi = await chat("Explain in two sentences what a deadlock is.");
  const doubled = /\b(\w{3,})\s+\1\b/i.test(hi.text);
  check("a reply streams, with no doubled words", hi.text.length > 40 && !doubled, hi.text.slice(0, 70).replace(/\n/g, " "));

  const due = new Date(Date.now() + 2 * 60_000);
  await chat("Remind me in 2 minutes to stretch.");
  const upcoming = state()?.upcoming?.find((u) => u.kind === "custom");
  const dueMs = upcoming ? Date.parse(upcoming.dueAt) : 0;
  check(
    "'in 2 minutes' became a reminder about 2 minutes away",
    !!upcoming && Math.abs(dueMs - due.getTime()) < 90_000,
    upcoming ? upcoming.dueAt : "no reminder created",
  );
  const fired = upcoming && (await waitFor((f) => f.type === "sf_reminder" && f.id === upcoming.id, 200_000));
  check("the reminder fires on time", !!fired);

  const plan = await call("startPlan", {
    courseName: "Operating Systems",
    examDate: day(12),
    material:
      "Syllabus\n1. Processes and scheduling\n2. Deadlocks\n3. Paging and virtual memory\n4. File systems\n5. Synchronization (semaphores, monitors)\n6. I/O and interrupts\nGrading: 60% exam, 40% labs. Office hours: Tuesday.",
    minutesPerDay: 90,
    sessionMinutes: 45,
    preferredTime: "19:00",
  });
  const review = await (async () => {
    for (let i = 0; i < 300; i++) {
      const p = state()?.activePlan;
      if (p && ["awaiting_approval", "failed"].includes(p.status)) return p;
      await sleep(200);
    }
  })();
  check("the plan workflow extracts topics and proposes a plan", review?.status === "awaiting_approval", review?.message ?? review?.status ?? "timed out");
  if (review?.status === "awaiting_approval") {
    const detail = await call("getPlan", { planId: plan.planId });
    const learn = detail.sessions.filter((s) => s.kind === "learn").map((s) => s.topic);
    check(
      "topics come from the syllabus, not the admin lines",
      learn.length >= 5 && !learn.some((t) => /grading|office/i.test(t)),
      learn.slice(0, 4).join(" | "),
    );
    await call("decidePlan", { planId: plan.planId, approve: true });
    const active = await (async () => {
      for (let i = 0; i < 150; i++) {
        if (state()?.activePlan?.status === "active") return true;
        await sleep(200);
      }
      return false;
    })();
    check("approving schedules the sessions", active && state().upcoming.some((u) => u.kind === "session"));
  }
} catch (e) {
  check("no unexpected error", false, e.message);
} finally {
  ws.close();
  const del = await fetch(`${BASE}/api/account/delete`, { method: "POST", headers: { cookie, origin: ORIGIN } });
  check("account deletion", del.status === 204);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
