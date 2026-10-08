import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, newSession, stub, until } from "./helpers.ts";
import type { StudyAgent } from "../../src/agents/study-agent.ts";

/** A UTC date-time N days from now at 10:00, in the YYYY-MM-DDTHH:mm form the tool expects. */
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10) + "T10:00";

const onboarding = { displayName: "Priya", timezone: "Asia/Kolkata", checkInTime: "08:00", courses: [{ name: "Operating Systems", examDate: "2099-01-01" }] };

async function setup(timezone = "Asia/Kolkata") {
  const s = await newSession();
  const c = await Client.connect(s.cookie);
  await c.call("completeOnboarding", { ...onboarding, timezone });
  return { ...s, c, agent: await stub(s.userId) };
}
const db = <T>(agent: DurableObjectStub<StudyAgent>, fn: (i: StudyAgent) => T) => runInDurableObject(agent, async (i: StudyAgent) => fn(i));
const rows = <T>(agent: DurableObjectStub<StudyAgent>, query: string) =>
  db(agent, (i) => [...(i as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(query)] as T[]);

describe("onboarding and check-in", () => {
  it("stores the profile, courses and exactly one pending check-in", async () => {
    const { c, agent } = await setup();
    const s = (await c.waitFor((f) => f.type === "cf_agent_state" && f.state?.profile?.onboarded)).state;
    expect(s.profile).toMatchObject({ displayName: "Priya", timezone: "Asia/Kolkata", onboarded: true });
    expect(s.courses[0].name).toBe("Operating Systems");
    const checkins = await rows<{ status: string }>(agent, "SELECT status FROM reminders WHERE kind='checkin' AND status='scheduled'");
    expect(checkins).toHaveLength(1);
    // changing the check-in time re-arms instead of adding a second one
    await c.call("updateProfile", { checkInTime: "21:30" });
    expect(await rows(agent, "SELECT 1 FROM reminders WHERE kind='checkin' AND status='scheduled'")).toHaveLength(1);
    c.close();
  });

  it("the check-in posts an agenda without calling the model and re-arms for the next day", async () => {
    const { c, agent } = await setup();
    const [{ id }] = await rows<{ id: string }>(agent, "SELECT id FROM reminders WHERE kind='checkin' AND status='scheduled'");
    const before = await rows<{ n: number }>(agent, "SELECT count(*) AS n FROM llm_usage");
    await runDurableObjectAlarm(agent); // not due yet: no-op
    await db(agent, (i) => i.dailyCheckIn({ reminderId: id }));
    const msgs = await until(
      () => c.frames.filter((f) => f.type === "cf_agent_chat_messages"),
      (m) => m.length > 0,
    );
    expect(JSON.stringify(msgs.at(-1))).toContain("Good");
    expect(await rows(agent, "SELECT 1 FROM reminders WHERE kind='checkin' AND status='scheduled'")).toHaveLength(1);
    expect((await rows<{ n: number }>(agent, "SELECT count(*) AS n FROM llm_usage"))[0].n).toBe(before[0].n);
    c.close();
  });
});

describe("chat with the mock model", () => {
  it("streams a reply, persists it, counts the turn and records runtime usage", async () => {
    const { c, agent } = await setup();
    await c.chat("Explain deadlocks to me");
    expect(c.text()).toContain("Mock coach");
    const s = await until(
      () => c.latestState(),
      (st) => st.usageToday.chatTurns === 1,
    );
    expect(s.usageToday.inputTokens).toBeGreaterThan(0);
    const usage = await rows<{ feature: string; input_tokens: number }>(agent, "SELECT feature, input_tokens FROM llm_usage");
    expect(usage.map((u) => u.feature)).toContain("chat");
    c.close();
  });

  it("validated tool call: remember saves a memory; the Memory panel lists and deletes it", async () => {
    const { c } = await setup();
    await c.chat("remember that I prefer worked examples");
    const mems = await until(
      () => c.call("listMemoryRows"),
      (m: any[]) => m.length === 1,
    );
    expect(mems[0]).toMatchObject({ kind: "preference" });
    await c.call("deleteMemory", { memoryId: mems[0].id });
    expect(await c.call("listMemoryRows")).toHaveLength(0);
    c.close();
  });

  it("createReminder from chat schedules a reminder that fires once, without a model call", async () => {
    const { c, agent } = await setup("UTC");
    const when = inDays(30);
    await c.chat(`remind me ${when} to email my TA`);
    const [r] = await until(
      () => rows<{ id: string; title: string; due_at: string; schedule_id: string }>(agent, "SELECT * FROM reminders WHERE kind='custom'"),
      (x) => x.length === 1,
    );
    expect(r.title).toBe("email my TA");
    expect(r.due_at).toBe(`${when}:00.000Z`);
    expect((await c.latestState()).upcoming.some((u: any) => u.id === r.id)).toBe(true);
    const usageBefore = (await rows<{ n: number }>(agent, "SELECT count(*) AS n FROM llm_usage"))[0].n;
    await db(agent, (i) => i.fireReminder({ reminderId: r.id }));
    await db(agent, (i) => i.fireReminder({ reminderId: r.id })); // idempotent
    expect((await rows<{ status: string }>(agent, `SELECT status FROM reminders WHERE id='${r.id}'`))[0].status).toBe("sent");
    const posted = (await db(agent, (i) => i.messages as unknown[])).filter((m) => JSON.stringify(m).includes("⏰")).length;
    expect(posted).toBe(1);
    expect((await rows<{ n: number }>(agent, "SELECT count(*) AS n FROM llm_usage"))[0].n).toBe(usageBefore);
    expect(c.frames.some((f) => f.type === "sf_reminder" && f.id === r.id)).toBe(true);
    c.close();
  });

  it("a reminder in the past is rejected by server-side validation, not scheduled", async () => {
    const { c, agent } = await setup("UTC");
    await c.chat("remind me 2020-01-01T10:00 to time travel");
    await until(
      () => c.latestState(),
      (st) => st.usageToday.chatTurns === 1,
    );
    expect(await rows(agent, "SELECT 1 FROM reminders WHERE kind='custom'")).toHaveLength(0);
    c.close();
  });

  it("a malformed tool call (prose date) never reaches the host", async () => {
    const { c, agent } = await setup("UTC");
    await c.chat("bad reminder please");
    await until(
      () => c.latestState(),
      (st) => st.usageToday.chatTurns === 1,
    );
    expect(await rows(agent, "SELECT 1 FROM reminders WHERE kind='custom'")).toHaveLength(0);
    c.close();
  });

  it("enforces the daily chat cap with a friendly assistant message and no model call", async () => {
    const { c, agent } = await setup();
    await db(agent, (i) => (i as any).setState({ ...i.state, caps: { ...i.state.caps, chatTurns: 1 } }));
    await c.chat("first");
    await until(
      () => c.latestState(),
      (st) => st.usageToday.chatTurns === 1,
    );
    const before = (await rows<{ n: number }>(agent, "SELECT count(*) AS n FROM llm_usage"))[0].n;
    await c.chat("second");
    expect(c.text()).toContain("today's limit");
    expect((await rows<{ n: number }>(agent, "SELECT count(*) AS n FROM llm_usage"))[0].n).toBe(before);
    c.close();
  });
});

describe("rolling summary", () => {
  it("folds old turns into a stored summary once the history budget is exceeded", async () => {
    const { c, agent } = await setup();
    const filler = "w".repeat(700);
    const history = Array.from({ length: 60 }, (_, i) => ({
      id: `h${i}`,
      role: i % 2 ? "assistant" : "user",
      parts: [{ type: "text", text: `turn ${i} ${filler}` }],
    }));
    await db(agent, (i) => i.persistMessages(history as never));
    await c.chat("What did we cover so far?", history);
    const row = await until(
      () => rows<{ text: string; upto_id: string }>(agent, "SELECT text, upto_id FROM chat_summary"),
      (r) => r.length === 1,
    );
    expect(row[0].text).toContain("Mock summary");
    expect(row[0].upto_id).toMatch(/^h\d+$/);
    const features = (await rows<{ feature: string }>(agent, "SELECT feature FROM llm_usage")).map((r) => r.feature);
    expect(features).toContain("summary");
    expect(features).toContain("chat");
    // the prompt that was actually sent stayed under the hard input limit
    const [{ input_tokens }] = await rows<{ input_tokens: number }>(agent, "SELECT input_tokens FROM llm_usage WHERE feature='chat'");
    expect(input_tokens).toBeLessThanOrEqual(20000);
    // clearing the chat clears the summary
    c.send({ type: "cf_agent_chat_clear" });
    await until(
      () => rows(agent, "SELECT 1 FROM chat_summary"),
      (r) => r.length === 0,
    );
    c.close();
  });
});

describe("account deletion", () => {
  it("cancels schedules and wipes everything, then clears the cookie", async () => {
    const { c, cookie, userId } = await setup();
    await c.chat(`remind me ${inDays(10)} to review notes`);
    await until(
      async () => (await stub(userId).then((a) => rows(a, "SELECT 1 FROM reminders WHERE kind='custom'"))).length,
      (n) => n === 1,
    );
    c.close();
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("http://localhost/api/account/delete", { method: "POST", headers: { Origin: "http://localhost:5173", Cookie: cookie } });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    // The destroyed object is recreated empty on next use (in workerd this can take a moment).
    const left = await until(
      async () => {
        try {
          return await rows<{ n: number }>(await stub(userId), "SELECT count(*) AS n FROM reminders");
        } catch {
          return null;
        }
      },
      (r) => r !== null,
    );
    expect(left![0].n).toBe(0);
  });
});

void env;
