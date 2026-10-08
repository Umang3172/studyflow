// Per-student SQLite schema (one Durable Object = one student). Created idempotently on every start.

export type Sql = <T = Record<string, string | number | boolean | null>>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => T[];

// ponytail: the version is recorded but there is no migration runner yet; add one when a table changes.
export const SCHEMA_VERSION = 1;

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('goal','preference','weak_topic','strength','fact')),
     content TEXT NOT NULL CHECK (length(content) <= 280), course_id TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plans (
     id TEXT PRIMARY KEY, course_id TEXT NOT NULL, course_name TEXT NOT NULL, exam_date TEXT NOT NULL,
     status TEXT NOT NULL, workflow_id TEXT, request_json TEXT NOT NULL, topics_json TEXT,
     overloaded INTEGER DEFAULT 0, note TEXT, created_at TEXT NOT NULL, decided_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS plan_sessions (
     id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
     starts_at TEXT NOT NULL, duration_min INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('learn','review','final')),
     topic TEXT NOT NULL, objective TEXT,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
     reminder_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS reminders (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('custom','session','checkin')),
     title TEXT NOT NULL CHECK (length(title) <= 200), due_at TEXT NOT NULL, schedule_id TEXT,
     status TEXT NOT NULL CHECK (status IN ('scheduled','sent','cancelled')), source TEXT NOT NULL,
     body TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quiz_results (
     id TEXT PRIMARY KEY, topic TEXT NOT NULL, course_id TEXT, correct INTEGER NOT NULL, total INTEGER NOT NULL,
     created_at TEXT NOT NULL)`,
  // Application runtime usage (separate from development usage in the README).
  `CREATE TABLE IF NOT EXISTS llm_usage (
     id TEXT PRIMARY KEY, ts TEXT NOT NULL, feature TEXT NOT NULL, model TEXT NOT NULL,
     input_tokens INTEGER, output_tokens INTEGER, audio_seconds INTEGER, neurons_est REAL)`,
  // Rolling summary of chat turns that no longer fit the history budget.
  `CREATE TABLE IF NOT EXISTS chat_summary (
     id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL, upto_id TEXT, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, due_at)`,
  `CREATE INDEX IF NOT EXISTS plan_sessions_plan ON plan_sessions (plan_id, starts_at)`,
  `CREATE INDEX IF NOT EXISTS memories_kind ON memories (kind, updated_at)`,
];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** 8-char ids: short enough to be cheap in prompts, and checked against the ID regex in the schemas. */
export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % 36]).join("");
}
