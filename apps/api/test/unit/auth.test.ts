import { describe, expect, it } from "vitest";
import { newUserId, originAllowed, readCookie, sessionCookie, signSession, verifySession } from "../../src/lib/auth.ts";

const SECRET = "unit-test-secret-unit-test-secret";

describe("session cookie", () => {
  it("signs and verifies a user id", async () => {
    const id = newUserId();
    const value = await signSession(id, SECRET);
    expect(await verifySession(value, SECRET)).toBe(id);
  });
  it("rejects a wrong secret, tampering and malformed values", async () => {
    const id = newUserId();
    const value = await signSession(id, SECRET);
    expect(await verifySession(value, "other-secret-other-secret-other")).toBeNull();
    const [idPart, mac] = value.split(".");
    const forged = await signSession(newUserId(), SECRET);
    expect(await verifySession(`${forged.split(".")[0]}.${mac}`, SECRET)).toBeNull();
    for (const bad of [undefined, "", "abc", "a.b.c", `${idPart}.`, `.${mac}`, "!!!.???"]) {
      expect(await verifySession(bad, SECRET)).toBeNull();
    }
  });
  it("rejects a validly signed value that is not a user id", async () => {
    expect(await verifySession(await signSession("admin", SECRET), SECRET)).toBeNull();
  });
  it("reads the cookie from a header and sets safe flags", () => {
    const req = new Request("https://x.test", { headers: { cookie: "a=1; sf_session=abc.def; b=2" } });
    expect(readCookie(req)).toBe("abc.def");
    const c = sessionCookie("v", true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
  });
});

describe("origin check", () => {
  const req = (origin?: string) => new Request("https://x.test", { headers: origin ? { origin } : {} });
  it("allows only listed origins", () => {
    const allowed = "https://studyflow.pages.dev, http://localhost:5173";
    expect(originAllowed(req("http://localhost:5173"), allowed)).toBe(true);
    expect(originAllowed(req("https://evil.test"), allowed)).toBe(false);
    expect(originAllowed(req(), allowed)).toBe(false);
  });
});
