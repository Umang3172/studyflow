// Anonymous, device-bound identity: sf_session = base64url(userId) "." base64url(HMAC-SHA256(secret, userId)).
// Rotating SESSION_SECRET signs everyone out (and orphans their data), so treat it as permanent.

export const COOKIE = "sf_session";
const MAX_AGE = 34_560_000; // 400 days, the browser maximum

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export async function signSession(userId: string, secret: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(userId));
  return `${b64url(enc.encode(userId))}.${b64url(mac)}`;
}

/** Returns the userId for a valid cookie value, otherwise null. Never throws on malformed input. */
export async function verifySession(value: string | undefined, secret: string): Promise<string | null> {
  try {
    const [idPart, macPart, extra] = (value ?? "").split(".");
    if (!idPart || !macPart || extra !== undefined) return null;
    const userId = new TextDecoder().decode(unb64url(idPart));
    if (!/^u_[0-9a-f-]{36}$/.test(userId)) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), unb64url(macPart), enc.encode(userId));
    return ok ? userId : null;
  } catch {
    return null;
  }
}

export const newUserId = () => `u_${crypto.randomUUID()}`;

export function readCookie(request: Request, name = COOKIE): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
}

export const sessionCookie = (value: string, secure: boolean) =>
  `${COOKIE}=${value}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
export const clearCookie = (secure: boolean) => `${COOKIE}=; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=0`;

/** Same-origin check for WebSocket upgrades and state-changing requests. */
export function originAllowed(request: Request, allowed: string): boolean {
  const origin = request.headers.get("origin");
  return (
    !!origin &&
    allowed
      .split(",")
      .map((s) => s.trim())
      .includes(origin)
  );
}
