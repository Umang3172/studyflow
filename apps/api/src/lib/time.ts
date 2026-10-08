// Timezone maths on top of Intl (no Temporal: see docs/spikes.md S3). Everything is stored in UTC;
// wall-clock time is converted only at the edges.

const MIN = 60_000;
const DAY = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };
function wallParts(utcMs: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(utcMs))) p[type] = Number(value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** Offset (local - UTC) in ms at an instant. */
function offsetAt(utcMs: number, tz: string): number {
  const w = wallParts(utcMs, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "YYYY-MM-DDTHH:mm" wall-clock time in `tz` -> UTC Date.
 * Ambiguous time (clocks go back): the earlier instant. Non-existent time (clocks go forward):
 * shifted forward by the gap, like Temporal's "compatible" mode.
 */
export function localToUtc(local: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`bad local date-time: ${local}`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const before = offsetAt(wall - DAY, tz);
  const after = offsetAt(wall + DAY, tz);
  const valid = [...new Set([before, after])].map((o) => wall - o).filter((c) => offsetAt(c, tz) === wall - c);
  if (valid.length) return new Date(Math.min(...valid));
  return new Date(wall - before);
}

export type Local = { date: string; time: string; weekday: string };

export function utcToLocal(date: Date | string | number, tz: string): Local {
  const w = wallParts(new Date(date).getTime(), tz);
  const dow = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
  return { date: `${w.y}-${pad(w.mo)}-${pad(w.d)}`, time: `${pad(w.h)}:${pad(w.mi)}`, weekday: WEEKDAYS[dow] };
}

/** "YYYY-MM-DD" + n days (pure calendar arithmetic, DST-free). */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / DAY);
}

export const toMinutes = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
export const fromMinutes = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** Next occurrence of local `hhmm` strictly after `now`, as a UTC Date. */
export function nextLocalOccurrence(hhmm: string, tz: string, now: Date): Date {
  const today = utcToLocal(now, tz).date;
  for (const day of [today, addDays(today, 1), addDays(today, 2)]) {
    const t = localToUtc(`${day}T${hhmm}`, tz);
    if (t.getTime() > now.getTime() + MIN) return t;
  }
  throw new Error("unreachable: no future occurrence within 3 days");
}

export const greeting = (hhmm: string) => (hhmm < "12:00" ? "morning" : hhmm < "18:00" ? "afternoon" : "evening");
