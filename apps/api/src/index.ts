import { getAgentByName } from "agents";
import { clearCookie, newUserId, originAllowed, readCookie, sessionCookie, signSession, verifySession } from "./lib/auth.ts";

export { StudyAgent } from "./agents/study-agent.ts";
export { VoiceInputAgent } from "./agents/voice-input-agent.ts";
export { StudyPlanWorkflow } from "./workflows/study-plan.ts";

// Public entry. The client never names its agent instance: the instance is derived from the signed
// cookie, so one student can never address another student's Durable Object. routeAgentRequest() is
// deliberately NOT used for public traffic (it would let anyone pick an instance name).

const VERSION = "0.1.0";
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", "cache-control": "no-store", ...init.headers } });

async function limited(limiter: RateLimit | undefined, key: string) {
  if (!limiter) return false; // binding absent (tests): no limiting
  return !(await limiter.limit({ key })).success;
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const secure = url.protocol === "https:";
    if (!env.SESSION_SECRET) return json({ error: "server is not configured" }, { status: 500 });

    if (path === "/api/health") return json({ ok: true, version: VERSION, voice: env.VOICE_ENABLED === "true" });

    if (path === "/api/session" && request.method === "GET") {
      const existing = await verifySession(readCookie(request), env.SESSION_SECRET);
      if (existing) return json({ ok: true });
      if (await limited(env.SESSION_LIMITER, request.headers.get("cf-connecting-ip") ?? "unknown")) return json({ error: "slow down" }, { status: 429 });
      const value = await signSession(newUserId(), env.SESSION_SECRET);
      return json({ ok: true }, { headers: { "set-cookie": sessionCookie(value, secure) } });
    }

    const isStudy = path === "/agents/study" || path.startsWith("/agents/study/");
    const isVoice = path === "/agents/voice" || path.startsWith("/agents/voice/");
    const isDelete = path === "/api/account/delete" && request.method === "POST";
    if (!isStudy && !isVoice && !isDelete) return json({ error: "not found" }, { status: 404 });

    // Cross-site WebSocket / CSRF defence: upgrades and anything that changes state must come from our origin.
    const mutating = !["GET", "HEAD"].includes(request.method);
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if ((mutating || upgrade || request.headers.has("origin")) && !originAllowed(request, env.ALLOWED_ORIGINS)) {
      return json({ error: "origin not allowed" }, { status: 403 });
    }

    const userId = await verifySession(readCookie(request), env.SESSION_SECRET);
    if (!userId) return json({ error: "no session" }, { status: 401 });
    if (await limited(env.CONNECT_LIMITER, userId)) return json({ error: "slow down" }, { status: 429 });

    if (isDelete) {
      const study = await getAgentByName(env.StudyAgent, userId);
      try {
        await study.deleteAllData(); // destroy() aborts the object, which can surface as an error here
      } catch {
        // expected after destroy
      }
      return new Response(null, { status: 204, headers: { "set-cookie": clearCookie(secure) } });
    }
    if (isVoice) {
      if (env.VOICE_ENABLED !== "true") return json({ error: "voice is disabled" }, { status: 404 });
      return (await getAgentByName(env.VoiceInputAgent, userId)).fetch(request);
    }
    return (await getAgentByName(env.StudyAgent, userId)).fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
