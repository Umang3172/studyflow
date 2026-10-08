let inFlight: Promise<void> | undefined;

/**
 * Ask the Worker for a signed, HttpOnly session cookie (a no-op when one already exists).
 * Single-flight: two concurrent first requests (React StrictMode runs effects twice in dev, and two tabs can open at once)
 * would each mint a different anonymous student, and the browser keeps whichever Set-Cookie arrives last.
 */
export function ensureSession(): Promise<void> {
  inFlight ??= fetch("/api/session", { credentials: "same-origin" }).then((res) => {
    if (!res.ok) throw new Error(res.status === 429 ? "Too many sessions from this network; try again in a minute." : "Could not start a session.");
  });
  inFlight.catch(() => (inFlight = undefined)); // allow "Try again" after a failure
  return inFlight;
}

export async function deleteAccount(): Promise<void> {
  const res = await fetch("/api/account/delete", { method: "POST", credentials: "same-origin" });
  if (!res.ok) throw new Error("Could not delete your data. Please try again.");
}
