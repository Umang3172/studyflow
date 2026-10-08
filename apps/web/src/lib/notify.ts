import type { ReminderEvent } from "@studyflow/shared";

export type Toast = { key: string; title: string; body?: string };

export const notificationsSupported = () => typeof Notification !== "undefined";

/** Browser notification only when the tab is hidden and permission was granted; the toast always shows. */
export function systemNotify(e: ReminderEvent) {
  if (!notificationsSupported() || Notification.permission !== "granted" || !document.hidden) return;
  try {
    new Notification(e.title, { body: e.body, tag: e.id });
  } catch {
    // some mobile browsers only allow notifications from a service worker; the in-app toast still shows
  }
}

export function parseReminder(data: unknown): ReminderEvent | null {
  if (typeof data !== "string" || !data.includes("sf_reminder")) return null;
  try {
    const m = JSON.parse(data);
    return m?.type === "sf_reminder" && typeof m.title === "string" ? m : null;
  } catch {
    return null;
  }
}
