import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, newSession, stub, until } from "./helpers.ts";
import type { StudyAgent } from "../../src/agents/study-agent.ts";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const material = ["Process scheduling", "Deadlocks", "Paging and virtual memory", "File systems", "Synchronization primitives", "I/O and interrupts"].join(
  "\n",
);
const request = (over = {}) => ({
  courseName: "Operating Systems",
  examDate: inDays(14),
  material,
  minutesPerDay: 90,
  sessionMinutes: 45,
  preferredTime: "19:00",
  ...over,
});

async function setup() {
  const s = await newSession();
  const c = await Client.connect(s.cookie);
  await c.call("completeOnboarding", { timezone: "UTC", checkInTime: "08:00", courses: [] });
  return { c, agent: await stub(s.userId) };
}
const rows = <T>(agent: DurableObjectStub<StudyAgent>, query: string) =>
  runInDurableObject(agent, async (i: StudyAgent) => [...(i as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(query)] as T[]);
const planState = (c: Client) => c.latestState()?.activePlan;

describe("startStudyPlan chat tool", () => {
  it("needs approval, then reads the pasted syllabus from the chat history instead of the model's arguments", async () => {
    const { c, agent } = await setup();
    // 1) the student pastes a syllabus as an ordinary message
    await c.chat(`Here is my syllabus:\n${material}`);
    const history = await runInDurableObject(agent, async (i: StudyAgent) => i.messages as unknown[]);
    // 2) they ask for a plan; the model's tool call carries no syllabus text
    const id = await c.chat(`make me a plan for Operating Systems exam ${inDays(14)}`, history);
    const approval = (await until(
      () =>
        c.frames
          .filter((f) => f.type === "cf_agent_use_chat_response" && f.id === id && f.body)
          .map((f) => JSON.parse(f.body))
          .find((b) => b.type === "tool-approval-request"),
      Boolean,
    )) as { toolCallId: string };
    expect(await rows(agent, "SELECT 1 FROM plans")).toHaveLength(0); // nothing starts before approval
    // 3) approving runs the tool on the server
    c.send({ type: "cf_agent_tool_approval", toolCallId: approval.toolCallId, approved: true, autoContinue: true });
    await until(
      () => planState(c),
      (p) => p?.status === "awaiting_approval",
      30000,
    );
    const [{ topics_json }] = await rows<{ topics_json: string }>(agent, "SELECT topics_json FROM plans");
    const titles = (JSON.parse(topics_json) as Array<{ title: string }>).map((t) => t.title);
    expect(titles).toContain("Deadlocks");
    expect(titles).toContain("I/O and interrupts");
    c.close();
  });

  it("refuses to start a plan when there is no syllabus anywhere", async () => {
    const { c, agent } = await setup();
    const id = await c.chat(`make me a plan for Operating Systems exam ${inDays(14)}`);
    const approval = (await until(
      () =>
        c.frames
          .filter((f) => f.type === "cf_agent_use_chat_response" && f.id === id && f.body)
          .map((f) => JSON.parse(f.body))
          .find((b) => b.type === "tool-approval-request"),
      Boolean,
    )) as { toolCallId: string };
    c.send({ type: "cf_agent_tool_approval", toolCallId: approval.toolCallId, approved: true, autoContinue: true });
    await until(() => c.frames.some((f) => f.body && String(f.body).includes("No syllabus")), Boolean, 15000).catch(() => undefined);
    expect(await rows(agent, "SELECT 1 FROM plans")).toHaveLength(0);
    c.close();
  });
});

describe("study plan workflow (mock model)", () => {
  it("extracts topics, proposes a plan, waits for approval, then schedules session reminders", async () => {
    const { c, agent } = await setup();
    const { planId } = await c.call("startPlan", request());
    expect(planState(c)?.status).toMatch(/generating|awaiting_approval/);

    await until(
      () => planState(c),
      (p) => p?.status === "awaiting_approval",
      30000,
    );
    const { plan, sessions } = await c.call("getPlan", { planId });
    expect(plan.status).toBe("awaiting_approval");
    expect(sessions.length).toBeGreaterThan(6);
    expect(sessions.at(-1).kind).toBe("final");
    // nothing is scheduled until the student approves
    expect(await rows(agent, "SELECT 1 FROM reminders WHERE kind='session'")).toHaveLength(0);
    // the one LLM call is recorded as runtime usage
    const usage = await rows<{ feature: string; input_tokens: number }>(agent, "SELECT feature, input_tokens FROM llm_usage WHERE feature='plan_extract'");
    expect(usage).toHaveLength(1);

    await c.call("decidePlan", { planId, approve: true });
    await until(
      () => planState(c),
      (p) => p?.status === "active",
      30000,
    );
    const scheduled = await rows<{ schedule_id: string }>(agent, "SELECT schedule_id FROM reminders WHERE kind='session' AND status='scheduled'");
    expect(scheduled.length).toBeGreaterThan(6);
    expect(scheduled.every((r) => r.schedule_id)).toBe(true);
    expect(c.latestState().upcoming.length).toBeGreaterThan(0);

    // marking every session done completes the plan
    for (const s of sessions) await c.call("markSession", { sessionId: s.id, status: "done" });
    expect(planState(c)?.status).toBe("completed");
    c.close();
  });

  it("rejecting a proposal leaves no reminders", async () => {
    const { c, agent } = await setup();
    const { planId } = await c.call("startPlan", request());
    await until(
      () => planState(c),
      (p) => p?.status === "awaiting_approval",
      30000,
    );
    await c.call("decidePlan", { planId, approve: false, reason: "too heavy" });
    await until(
      () => planState(c),
      (p) => p?.status === "rejected",
      30000,
    );
    expect(await rows(agent, "SELECT 1 FROM reminders WHERE kind='session'")).toHaveLength(0);
    // a new plan can start after a rejection
    await c.call("startPlan", request());
    c.close();
  });

  it("fails cleanly when the material has no topics, and allows a retry", async () => {
    const { c } = await setup();
    await c.call("startPlan", request({ material: "just one line" }));
    await until(
      () => planState(c),
      (p) => p?.status === "failed",
      60000,
    );
    expect(planState(c).message).toMatch(/topics/i);
    await c.call("startPlan", request());
    c.close();
  });

  it("validates the request: past or too-distant exam dates, one active plan, daily cap", async () => {
    const { c, agent } = await setup();
    await expect(c.call("startPlan", request({ examDate: inDays(0) }))).rejects.toThrow(/Exam date/);
    await expect(c.call("startPlan", request({ examDate: inDays(400) }))).rejects.toThrow(/Exam date/);
    await c.call("startPlan", request());
    await expect(c.call("startPlan", request())).rejects.toThrow(/current plan/);
    await runInDurableObject(agent, async (i: StudyAgent) => (i as any).setState({ ...i.state, caps: { ...i.state.caps, planStarts: 1 } }));
    await expect(c.call("startPlan", request())).rejects.toThrow(/limit/);
    c.close();
  });
});
