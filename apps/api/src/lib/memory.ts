import { LIMITS, type MemoryKind } from "@studyflow/shared";
import { newId, type Sql } from "./db.ts";

export type Memory = { id: string; kind: MemoryKind; content: string; course_id: string | null; created_at: string; updated_at: string };

// goal > weak_topic > preference > strength > fact, then relevance to the current message, then recency.
const WEIGHT: Record<MemoryKind, number> = { goal: 5, weak_topic: 4, preference: 3, strength: 2, fact: 1 };

/** Memory text is student/LLM-authored and ends up in the prompt: flatten it so it cannot add structure. */
export const cleanMemory = (s: string) =>
  s
    .replace(/[<>\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.memoryChars);

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

// ponytail: keyword overlap is enough for <= 50 short rows, upgrade to embeddings (Vectorize) if memory grows.
export function rankMemories(rows: Memory[], query: string): Memory[] {
  const q = words(query);
  const score = (m: Memory) => WEIGHT[m.kind] + [...words(m.content)].filter((w) => q.has(w)).length * 3;
  return [...rows].sort((a, b) => score(b) - score(a) || b.updated_at.localeCompare(a.updated_at));
}

export const listMemories = (sql: Sql): Memory[] =>
  sql<Memory>`SELECT id, kind, content, course_id, created_at, updated_at FROM memories ORDER BY updated_at DESC`;

/** Insert or refresh. Identical text (case/space-insensitive) only bumps updated_at; the oldest `fact` is evicted at the cap. */
export function remember(sql: Sql, input: { kind: MemoryKind; content: string; courseId?: string | null }, now: Date): { id: string; created: boolean } {
  const content = cleanMemory(input.content);
  if (!content) throw new Error("empty memory");
  const ts = now.toISOString();
  const same = sql<{ id: string }>`SELECT id FROM memories WHERE kind = ${input.kind} AND lower(content) = ${content.toLowerCase()}`;
  if (same[0]) {
    sql`UPDATE memories SET updated_at = ${ts} WHERE id = ${same[0].id}`;
    return { id: same[0].id, created: false };
  }
  const [{ n }] = sql<{ n: number }>`SELECT count(*) AS n FROM memories`;
  if (n >= LIMITS.memoryRows) {
    const victim =
      sql<{ id: string }>`SELECT id FROM memories WHERE kind = 'fact' ORDER BY updated_at ASC LIMIT 1`[0] ??
      sql<{ id: string }>`SELECT id FROM memories ORDER BY updated_at ASC LIMIT 1`[0];
    sql`DELETE FROM memories WHERE id = ${victim.id}`;
  }
  const id = newId();
  sql`INSERT INTO memories (id, kind, content, course_id, created_at, updated_at) VALUES (${id}, ${input.kind}, ${content}, ${input.courseId ?? null}, ${ts}, ${ts})`;
  return { id, created: true };
}

/** Deterministic quiz -> memory update: <60% marks a weak topic, >=80% turns a weak topic into a strength. */
export function applyQuizResult(sql: Sql, topic: string, correct: number, total: number, now: Date): "weak" | "strong" | "none" {
  const pct = correct / total;
  const label = cleanMemory(topic);
  const weak = sql<{ id: string }>`SELECT id FROM memories WHERE kind = 'weak_topic' AND lower(content) = ${label.toLowerCase()}`[0];
  if (pct < 0.6) {
    remember(sql, { kind: "weak_topic", content: label }, now);
    return "weak";
  }
  if (pct >= 0.8 && weak) {
    sql`DELETE FROM memories WHERE id = ${weak.id}`;
    remember(sql, { kind: "strength", content: label }, now);
    return "strong";
  }
  return "none";
}
