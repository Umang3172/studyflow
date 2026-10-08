import { SELF, env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { verifySession } from "../../src/lib/auth.ts";

export const ORIGIN = "http://localhost:5173";
export const BASE = "http://localhost";

/** Mint a session through the real endpoint; returns the Cookie header value and the user id. */
export async function newSession(): Promise<{ cookie: string; userId: string }> {
  const res = await SELF.fetch(`${BASE}/api/session`);
  const set = res.headers.get("set-cookie") ?? "";
  const cookie = set.split(";")[0];
  const userId = (await verifySession(cookie.split("=")[1], env.SESSION_SECRET))!;
  return { cookie, userId };
}

export const stub = (userId: string) => getAgentByName(env.StudyAgent, userId);

export type Frame = Record<string, any>;

export class Client {
  frames: Frame[] = [];
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      try {
        this.frames.push(JSON.parse(e.data as string));
      } catch {
        // binary or non-JSON frame
      }
    });
  }

  static async connect(cookie: string, path = "/agents/study"): Promise<Client> {
    const res = await SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: "websocket", Origin: ORIGIN, Cookie: cookie } });
    if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
    res.webSocket.accept();
    return new Client(res.webSocket);
  }

  send(frame: Frame) {
    this.ws.send(JSON.stringify(frame));
  }

  async waitFor(pred: (f: Frame) => boolean, ms = 8000): Promise<Frame> {
    const start = Date.now();
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) throw new Error(`timeout; frames: ${this.frames.map((f) => f.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Callable RPC over the socket, like agent.call() in the browser. */
  async call(method: string, ...args: unknown[]): Promise<any> {
    const id = crypto.randomUUID();
    this.send({ type: "rpc", id, method, args });
    const f = await this.waitFor((x) => x.type === "rpc" && x.id === id);
    if (!f.success) throw new Error(f.error);
    return f.result;
  }

  /** Send a chat message and resolve when its response stream is done. */
  async chat(text: string, history: unknown[] = []): Promise<string> {
    const id = crypto.randomUUID();
    const messages = [...history, { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] }];
    this.send({ type: "cf_agent_use_chat_request", id, init: { method: "POST", body: JSON.stringify({ messages }) } });
    await this.waitFor((f) => f.type === "cf_agent_use_chat_response" && f.id === id && f.done === true, 15000);
    return id;
  }

  /** Assistant text streamed for a request id (concatenated text-delta chunks). */
  text(id?: string): string {
    return this.frames
      .filter((f) => f.type === "cf_agent_use_chat_response" && f.body && (!id || f.id === id))
      .map((f) => {
        try {
          const chunk = JSON.parse(f.body);
          return chunk.type === "text-delta" ? chunk.delta : "";
        } catch {
          return "";
        }
      })
      .join("");
  }

  latestState(): any {
    return [...this.frames].reverse().find((f) => f.type === "cf_agent_state")?.state;
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`condition not met in ${ms}ms; last: ${JSON.stringify(v)}`);
    await sleep(50);
  }
}
