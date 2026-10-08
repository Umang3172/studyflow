import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, Client, ORIGIN, newSession } from "./helpers.ts";

const ob = { displayName: "Alice", timezone: "UTC", checkInTime: "08:00", courses: [{ name: "OS", examDate: "2099-01-01" }] };

describe("worker entry", () => {
  it("health is public", async () => {
    const r = await SELF.fetch(`${BASE}/api/health`);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it("mints a signed HttpOnly cookie once and never returns the user id", async () => {
    const r = await SELF.fetch(`${BASE}/api/session`);
    const set = r.headers.get("set-cookie")!;
    expect(set).toMatch(/^sf_session=/);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(JSON.stringify(await r.json())).not.toContain("u_");
    const again = await SELF.fetch(`${BASE}/api/session`, { headers: { cookie: set.split(";")[0] } });
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("rejects agent traffic without a valid session", async () => {
    const none = await SELF.fetch(`${BASE}/agents/study`, { headers: { Upgrade: "websocket", Origin: ORIGIN } });
    expect(none.status).toBe(401);
    const forged = await SELF.fetch(`${BASE}/agents/study`, { headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: "sf_session=dXNlcg.AAAA" } });
    expect(forged.status).toBe(401);
  });

  it("rejects cross-site WebSocket upgrades and cross-site state changes", async () => {
    const { cookie } = await newSession();
    const ws = await SELF.fetch(`${BASE}/agents/study`, { headers: { Upgrade: "websocket", Origin: "https://evil.example", Cookie: cookie } });
    expect(ws.status).toBe(403);
    const noOrigin = await SELF.fetch(`${BASE}/agents/study`, { headers: { Upgrade: "websocket", Cookie: cookie } });
    expect(noOrigin.status).toBe(403);
    const del = await SELF.fetch(`${BASE}/api/account/delete`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: cookie } });
    expect(del.status).toBe(403);
  });

  it("unknown paths are 404 and the default agent route is not exposed", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
    const { cookie } = await newSession();
    const r = await SELF.fetch(`${BASE}/agents/study-agent/someone-else`, { headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: cookie } });
    expect(r.status).toBe(404);
  });

  it("isolates students: user B never sees user A's data", async () => {
    const a = await newSession();
    const b = await newSession();
    const ca = await Client.connect(a.cookie);
    await ca.call("completeOnboarding", ob);
    await ca.waitFor((f) => f.type === "cf_agent_state" && f.state?.profile?.onboarded === true);
    const cb = await Client.connect(b.cookie);
    const stateB = (await cb.waitFor((f) => f.type === "cf_agent_state")).state;
    expect(stateB.profile.onboarded).toBe(false);
    expect(stateB.courses).toEqual([]);
    expect(JSON.stringify(cb.frames)).not.toContain("Alice");
    ca.close();
    cb.close();
  });

  it("never sends the internal user id to the browser, on either agent socket", async () => {
    const { cookie, userId } = await newSession();
    const study = await Client.connect(cookie);
    const voice = await Client.connect(cookie, "/agents/voice/me");
    await study.waitFor((f) => f.type === "cf_agent_state");
    await voice.waitFor((f) => f.type === "welcome");
    await new Promise((r) => setTimeout(r, 300));
    for (const c of [study, voice]) {
      expect(JSON.stringify(c.frames)).not.toContain(userId);
      expect(c.frames.some((f) => f.type === "cf_agent_identity")).toBe(false);
    }
    study.close();
    voice.close();
  });

  it("clients cannot write synced state", async () => {
    const { cookie } = await newSession();
    const c = await Client.connect(cookie);
    await c.waitFor((f) => f.type === "cf_agent_state");
    c.send({
      type: "cf_agent_state",
      state: {
        profile: { onboarded: true, timezone: "UTC", checkInTime: "08:00", voiceEnabled: true },
        courses: [],
        upcoming: [],
        usageToday: {},
        caps: { chatTurns: 999999 },
        features: { voice: true },
      },
    });
    const err = await c.waitFor((f) => f.type === "cf_agent_state_error");
    expect(err.error).toMatch(/rejected/i);
    const c2 = await Client.connect(cookie);
    const s = (await c2.waitFor((f) => f.type === "cf_agent_state")).state;
    expect(s.profile.onboarded).toBe(false);
    expect(s.caps.chatTurns).toBe(40);
    c.close();
    c2.close();
  });

  it("callables validate their arguments", async () => {
    const { cookie } = await newSession();
    const c = await Client.connect(cookie);
    await expect(c.call("completeOnboarding", { timezone: "Mars/Base", courses: [] })).rejects.toThrow(/timezone/);
    await expect(c.call("deleteMemory", { memoryId: "../../etc" })).rejects.toThrow(/memoryId/);
    await expect(c.call("startPlan", { courseName: "OS" })).rejects.toThrow();
    await expect(c.call("decidePlan", { planId: "zzzzzzzz", approve: true })).rejects.toThrow(/not waiting/);
    c.close();
  });
});
