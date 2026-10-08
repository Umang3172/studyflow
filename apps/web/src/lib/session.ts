/** Ask the Worker for a signed, HttpOnly session cookie (a no-op when one already exists). */
export async function ensureSession(): Promise<void> {
  const res = await fetch("/api/session", { credentials: "same-origin" });
  if (!res.ok) throw new Error(res.status === 429 ? "Too many sessions from this network; try again in a minute." : "Could not start a session.");
}

export async function deleteAccount(): Promise<void> {
  const res = await fetch("/api/account/delete", { method: "POST", credentials: "same-origin" });
  if (!res.ok) throw new Error("Could not delete your data. Please try again.");
}
