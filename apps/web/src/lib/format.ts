export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function formatWhen(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

export function relative(iso: string, now = Date.now()): string {
  const mins = Math.round((Date.parse(iso) - now) / 60000);
  const abs = Math.abs(mins);
  const text = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return mins >= 0 ? `in ${text}` : `${text} ago`;
}

/** Strip Markdown so text-to-speech does not read out symbols. */
export const plainText = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>~|-]{1,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const KIND_LABEL = { session: "Study", custom: "Reminder", checkin: "Check-in" } as const;
export const KIND_ICON = { session: "📚", custom: "⏰", checkin: "☀️" } as const;
