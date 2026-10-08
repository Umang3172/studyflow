import { LIMITS, type Topic } from "@studyflow/shared";
import { addDays, daysBetween, fromMinutes, localToUtc, toMinutes } from "./time.ts";

// Deterministic study-plan allocator. The LLM only extracts topics; dates, capacity and DST are
// handled here so they are testable and cost zero tokens.

export type PlannerInput = {
  topics: Topic[];
  today: string; // local YYYY-MM-DD
  nowLocalTime: string; // local HH:mm
  examDate: string;
  minutesPerDay: number;
  sessionMinutes: number;
  preferredTime: string; // HH:mm, start of the first daily slot
  timezone: string;
};

export type PlanSession = {
  startsAt: string; // UTC ISO
  durationMin: number;
  kind: "learn" | "review" | "final";
  topic: string;
  objective: string;
};

export type PlanResult = { sessions: PlanSession[]; overloaded: boolean; suggestedMinutesPerDay?: number };

export class PlanError extends Error {}

type Unit = { kind: "learn" | "review"; topic: string; key: string; objective: string; notBefore: number };
type Tier = { reviews: number[]; group: number | "auto" };

// Cheapest first: fewer reviews free more slots for learning; grouping topics is the last resort and marks the plan overloaded.
const TIERS: Tier[] = [
  { reviews: [1, 3, 7], group: 1 },
  { reviews: [1, 3], group: 1 },
  { reviews: [1], group: 1 },
  { reviews: [], group: 1 },
  { reviews: [], group: 2 },
  { reviews: [], group: "auto" },
];

type Slot = { day: number; slot: number; unit: Unit };

/**
 * Place units day by day. While topics are still being learned, reviews may use at most half the day's slots
 * (rounded down), so learning is never starved. Returns null if a learn unit is left over; reviews that never
 * find a slot are dropped.
 */
function place(units: Unit[][], studyDays: number, slotsPerDay: number, reviewOffsets: number[]): Slot[] | null {
  const learn = units.flat();
  const reviews: Unit[] = [];
  const out: Slot[] = [];
  let next = 0;
  for (let day = 0; day < studyDays; day++) {
    let slot = 0;
    const reviewCap = next < learn.length ? Math.floor(slotsPerDay / 2) : slotsPerDay;
    for (let i = 0, used = 0; i < reviews.length && used < reviewCap;) {
      if (reviews[i].notBefore <= day) {
        out.push({ day, slot: slot++, unit: reviews.splice(i, 1)[0] });
        used++;
      } else i++;
    }
    while (slot < slotsPerDay && next < learn.length) {
      const unit = learn[next++];
      out.push({ day, slot: slot++, unit });
      // Reviews are queued when the topic's last learn unit is placed.
      if (next === learn.length || learn[next].key !== unit.key) {
        for (const off of reviewOffsets) {
          reviews.push({ kind: "review", topic: unit.key, key: unit.key, objective: `Recall: ${unit.objective}`, notBefore: day + off });
        }
      }
    }
    // Learning finished mid-day: use the remaining slots for reviews that are already due.
    for (let i = 0; i < reviews.length && slot < slotsPerDay && next >= learn.length;) {
      if (reviews[i].notBefore <= day) out.push({ day, slot: slot++, unit: reviews.splice(i, 1)[0] });
      else i++;
    }
  }
  return next < learn.length ? null : out;
}

function learnUnits(topics: Topic[], group: number): Unit[][] {
  const base: Unit[] = [];
  const size = group === 1 ? 1 : group;
  if (size === 1) {
    for (const t of topics) {
      const parts = t.difficulty === 3 ? 2 : 1;
      for (let p = 1; p <= parts; p++) {
        base.push({ kind: "learn", topic: parts > 1 ? `${t.title} (part ${p}/2)` : t.title, key: t.title, objective: t.objective, notBefore: 0 });
      }
    }
    return base.map((u) => [u]);
  }
  const grouped: Unit[][] = [];
  for (let i = 0; i < topics.length; i += size) {
    const chunk = topics.slice(i, i + size);
    const topic = chunk.map((t) => t.title).join(" + ");
    grouped.push([{ kind: "learn", topic, key: topic, objective: chunk.map((t) => t.objective).join(" "), notBefore: 0 }]);
  }
  return grouped;
}

export function allocate(input: PlannerInput): PlanResult {
  const { topics, today, nowLocalTime, examDate, sessionMinutes, preferredTime, timezone } = input;
  if (!topics.length) throw new PlanError("no topics to plan");
  if (daysBetween(today, examDate) < 1) throw new PlanError("exam date must be after today");

  const firstDay = toMinutes(preferredTime) > toMinutes(nowLocalTime) ? today : addDays(today, 1);
  const lastDay = addDays(examDate, -1);
  const total = daysBetween(firstDay, lastDay) + 1;
  if (total < 1) throw new PlanError("exam is too soon for a plan; ask me for a quick review instead");

  const hasFinal = total >= 2;
  const studyDays = hasFinal ? total - 1 : total;
  const step = sessionMinutes + 10;
  const maxSlots = Math.max(1, Math.floor((1439 - toMinutes(preferredTime)) / step) + 1);
  const slotsFor = (minutesPerDay: number) => Math.min(maxSlots, Math.max(1, Math.floor(minutesPerDay / sessionMinutes)));
  const slotsPerDay = slotsFor(input.minutesPerDay);
  const reserve = hasFinal ? 1 : 0;

  const attempt = (slots: number, tier: Tier) => {
    const group = tier.group === "auto" ? Math.max(2, Math.ceil(topics.length / Math.max(1, slots * studyDays))) : tier.group;
    const placed = place(learnUnits(topics, group), studyDays, slots, tier.reviews);
    return placed && placed.length + reserve <= LIMITS.sessionsMax ? placed : null;
  };

  let placed: Slot[] | null = null;
  let tierIndex = 0;
  for (; tierIndex < TIERS.length && !placed; tierIndex++) placed = attempt(slotsPerDay, TIERS[tierIndex]);
  if (!placed) throw new PlanError("too many topics for the days left; shorten the list or move the exam date");
  const overloaded = TIERS[tierIndex - 1].group !== 1;

  let suggestedMinutesPerDay: number | undefined;
  if (overloaded) {
    for (let s = slotsPerDay + 1; s <= maxSlots && s <= 8; s++) {
      if (attempt(s, TIERS[0])) {
        suggestedMinutesPerDay = Math.min(240, s * sessionMinutes);
        break;
      }
    }
  }

  const when = (dayIndex: number, slot: number) =>
    localToUtc(`${addDays(firstDay, dayIndex)}T${fromMinutes(toMinutes(preferredTime) + slot * step)}`, timezone).toISOString();
  const sessions: PlanSession[] = placed.map(({ day, slot, unit }) => ({
    startsAt: when(day, slot),
    durationMin: sessionMinutes,
    kind: unit.kind,
    topic: unit.topic,
    objective: unit.objective,
  }));
  if (hasFinal) {
    sessions.push({
      startsAt: when(total - 1, 0),
      durationMin: sessionMinutes,
      kind: "final",
      topic: "Mixed review and practice test",
      objective: "Quiz yourself across every topic and revisit the weak ones.",
    });
  }
  sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { sessions, overloaded, suggestedMinutesPerDay };
}
