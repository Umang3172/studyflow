import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, type Connection } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  isStepCount,
  pruneMessages,
  streamText,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  DEFAULT_CAPS,
  LIMITS,
  decidePlanInput,
  initialStudyState,
  markSessionInput,
  memoryIdInput,
  onboardingInput,
  planIdInput,
  planRequest,
  profileUpdate,
  stripLeakedToolCalls,
  type PlanStatus,
  type StudyState,
  type Topic,
  type UpcomingItem,
} from "@studyflow/shared";
import { BUDGET, estimateTokens } from "../lib/budget.ts";
import { buildContext } from "../lib/context.ts";
import { SCHEMA, SCHEMA_VERSION, newId, type Sql } from "../lib/db.ts";
import { dropToFit, planHistory, type Summary } from "../lib/history.ts";
import { applyQuizResult, listMemories, remember } from "../lib/memory.ts";
import { chatModel } from "../lib/model.ts";
import type { PlanResult } from "../lib/planner.ts";
import { SUMMARY_SYSTEM, TUTOR_SYSTEM, summaryPrompt } from "../lib/prompts.ts";
import { checkInMessage, reminderMessage, reminderTime, ReminderError } from "../lib/reminders.ts";
import { daysBetween, nextLocalOccurrence, utcToLocal } from "../lib/time.ts";
import { studyTools, toolsFor, type ToolHost } from "../lib/tools.ts";
import { LLAMA, NOVA, recordUsage, usageSince, type Feature } from "../lib/usage.ts";
import type { PlanParams } from "../workflows/study-plan.ts";

const DAY = 86_400_000;
const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : fallback);

/** Throw a short, client-safe message for invalid input instead of a zod stack. */
function check<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw new Error(`${i.path.join(".") || "input"}: ${i.message}`);
}

type PlanRow = {
  id: string;
  course_id: string;
  course_name: string;
  exam_date: string;
  status: PlanStatus;
  workflow_id: string | null;
  request_json: string;
  overloaded: number;
  note: string | null;
};
type ReminderRow = {
  id: string;
  kind: "custom" | "session" | "checkin";
  title: string;
  due_at: string;
  schedule_id: string | null;
  status: string;
  body: string | null;
};

export class StudyAgent extends AIChatAgent<Cloudflare.Env, StudyState> {
  // The instance name is the student's internal user id: never send it to the browser.
  static options = { sendIdentityOnConnect: false };
  initialState = initialStudyState();
  maxPersistedMessages = 400;
  private rememberedThisTurn = 0;
  private reminderRefused = false; // set after a rejected time: the model must ask the student, not guess another

  /** Overridable clock for tests. */
  protected now(): Date {
    return new Date();
  }
  private get db(): Sql {
    return this.sql.bind(this) as unknown as Sql;
  }
  private get tz() {
    return this.state.profile.timezone;
  }

  // ---------- lifecycle ----------
  async onStart() {
    for (const ddl of SCHEMA) this.ctx.storage.sql.exec(ddl);
    this.db`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ${String(SCHEMA_VERSION)})`;
    const caps = {
      chatTurns: num(this.env.DAILY_CHAT_TURNS, DEFAULT_CAPS.chatTurns),
      planStarts: num(this.env.DAILY_PLAN_STARTS, DEFAULT_CAPS.planStarts),
      voiceSeconds: num(this.env.DAILY_VOICE_SECONDS, DEFAULT_CAPS.voiceSeconds),
    };
    this.patch({ caps, features: { voice: this.env.VOICE_ENABLED === "true" } });
  }

  /** Clients can never write state; only the server (and its workflows) can. */
  validateStateChange(_next: StudyState, source: Connection | "server") {
    if (source !== "server") throw new Error("State is read-only for clients");
  }

  // Clearing the chat (the only caller of resetTurnState) also drops the rolling summary that described it.
  protected resetTurnState() {
    this.db`DELETE FROM chat_summary`;
    super.resetTurnState();
  }

  /** User text is capped on the server too; tool calls the model leaked into its prose never reach storage or its own history. */
  protected sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    const text = (fn: (t: string) => string): UIMessage => ({
      ...message,
      parts: message.parts.map((p) => (p.type === "text" ? { ...p, text: fn(p.text) } : p)),
    });
    return message.role === "user" ? text((t) => t.slice(0, LIMITS.userMessageChars)) : message.role === "assistant" ? text(stripLeakedToolCalls) : message;
  }

  private patch(partial: Partial<StudyState>) {
    this.setState({ ...this.state, ...partial });
  }

  // ---------- usage counters and caps ----------
  private usageToday(): StudyState["usageToday"] {
    const date = utcToLocal(this.now(), this.tz).date;
    const u = this.state.usageToday;
    return u.date === date ? u : { date, chatTurns: 0, planStarts: 0, voiceSeconds: 0, inputTokens: 0, outputTokens: 0 };
  }
  private bump(delta: Partial<Omit<StudyState["usageToday"], "date">>) {
    const u = this.usageToday();
    this.patch({
      usageToday: {
        ...u,
        chatTurns: u.chatTurns + (delta.chatTurns ?? 0),
        planStarts: u.planStarts + (delta.planStarts ?? 0),
        voiceSeconds: u.voiceSeconds + (delta.voiceSeconds ?? 0),
        inputTokens: u.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: u.outputTokens + (delta.outputTokens ?? 0),
      },
    });
  }
  private record(feature: Feature, u: { inputTokens?: number; outputTokens?: number }) {
    const input = u.inputTokens ?? 0;
    const output = u.outputTokens ?? 0;
    recordUsage(this.db, { feature, model: LLAMA, input, output }, this.now());
    this.bump({ inputTokens: input, outputTokens: output });
  }

  // ---------- chat ----------
  /** A canned assistant message as a proper UI stream (used for cap notices; no model call). */
  private reply(text: string): Response {
    const id = newId();
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  async onChatMessage(_onFinish: unknown, options?: { abortSignal?: AbortSignal; continuation?: boolean }): Promise<Response | undefined> {
    const messages = this.messages as UIMessage[];
    const last = messages[messages.length - 1];
    if (!options?.continuation) {
      if (this.usageToday().chatTurns >= this.state.caps.chatTurns) {
        return this.reply(`You have reached today's limit of ${this.state.caps.chatTurns} messages. Your plan and reminders keep working; come back tomorrow.`);
      }
      this.bump({ chatTurns: 1 });
      this.rememberedThisTurn = 0;
      this.reminderRefused = false;
    }

    const model = chatModel(this.env, this.sessionAffinity);
    const now = this.now();
    const text = (last?.parts as Array<{ type: string; text?: string }> | undefined)?.map((p) => (p.type === "text" ? p.text : "")).join(" ") ?? "";

    // Rolling summary: fold older turns into one short paragraph; the model sees summary + newest turns.
    const stored = this.db<{ text: string; upto_id: string | null }>`SELECT text, upto_id FROM chat_summary WHERE id = 1`[0];
    const plan = await planHistory(messages, { text: stored?.text ?? "", uptoId: stored?.upto_id ?? null }, (prev, transcript) =>
      this.summarize(model, prev, transcript),
    );
    if (plan.folded.length) this.saveSummary(plan.summary);

    const system = `${TUTOR_SYSTEM}\n\n${this.studentContext(now, text, plan.summary)}`;
    const kept = dropToFit(plan.kept, estimateTokens(system) + BUDGET.tools, BUDGET.hardInput - BUDGET.output);

    const result = streamText({
      model,
      system,
      messages: pruneMessages({ messages: await convertToModelMessages(kept), toolCalls: "before-last-2-messages" }),
      tools: this.toolsForTurn(kept),
      stopWhen: isStepCount(4),
      maxOutputTokens: BUDGET.output,
      temperature: 0.5,
      abortSignal: options?.abortSignal,
      onFinish: ({ totalUsage }) => this.record("chat", totalUsage),
    });
    return result.toUIMessageStreamResponse();
  }

  /** Only the tools this conversation needs (see toolsFor). */
  private toolsForTurn(history: UIMessage[]) {
    const all = studyTools(this.toolHost());
    const recent = history.slice(-3);
    const text = recent.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ")).join("\n");
    const lastReply = [...recent].reverse().find((m) => m.role === "assistant");
    const used = (lastReply?.parts ?? []).filter((p) => p.type.startsWith("tool-")).map((p) => p.type.slice(5));
    const names = toolsFor(text, used);
    return names.length ? Object.fromEntries(names.map((n) => [n, all[n]])) : undefined;
  }

  private async summarize(model: ReturnType<typeof chatModel>, previous: string, transcript: string): Promise<string> {
    const r = await generateText({ model, system: SUMMARY_SYSTEM, prompt: summaryPrompt(previous, transcript), maxOutputTokens: 300, temperature: 0.2 });
    this.record("summary", r.usage);
    return r.text;
  }

  private saveSummary(s: Summary) {
    this.db`INSERT INTO chat_summary (id, text, upto_id, updated_at) VALUES (1, ${s.text}, ${s.uptoId}, ${this.now().toISOString()})
            ON CONFLICT(id) DO UPDATE SET text = excluded.text, upto_id = excluded.upto_id, updated_at = excluded.updated_at`;
  }

  private studentContext(now: Date, query: string, summary: Summary): string {
    const plan = this.db<PlanRow>`SELECT * FROM plans WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`[0];
    let planInfo;
    if (plan) {
      const [{ done, total }] = this.db<{
        done: number;
        total: number;
      }>`SELECT sum(status != 'pending') AS done, count(*) AS total FROM plan_sessions WHERE plan_id = ${plan.id}`;
      const next = this.db<{
        topic: string;
        starts_at: string;
      }>`SELECT topic, starts_at FROM plan_sessions WHERE plan_id = ${plan.id} AND status = 'pending' AND starts_at > ${now.toISOString()} ORDER BY starts_at LIMIT 1`[0];
      planInfo = { course: plan.course_name, done: done ?? 0, total, next: next && { topic: next.topic, startsAt: next.starts_at } };
    }
    return buildContext({
      now,
      timezone: this.tz,
      displayName: this.state.profile.displayName,
      courses: this.state.courses,
      plan: planInfo,
      upcoming: this.state.upcoming.filter((u) => u.kind !== "checkin"),
      memories: listMemories(this.db),
      summary: summary.text,
      query,
    });
  }

  // ---------- tools (see lib/tools.ts) ----------
  private toolHost(): ToolHost {
    return {
      remember: (i) => {
        if (++this.rememberedThisTurn > 2) throw new Error("Only 2 memories per turn");
        const course = i.course ? this.state.courses.find((c) => c.name.toLowerCase() === i.course!.toLowerCase())?.id : undefined;
        return { ok: true, ...remember(this.db, { kind: i.kind, content: i.content, courseId: course }, this.now()) };
      },
      createReminder: async (i) => {
        if (this.reminderRefused) throw new ReminderError("Ask the student for a new time instead of guessing another.");
        if (!this.studentSaid(i.when)) throw new ReminderError("The student did not give that time. Ask when, then call again quoting their words in 'when'.");
        let at: Date;
        try {
          at = reminderTime(i.localDateTime, this.tz, this.now());
        } catch (e) {
          this.reminderRefused = true;
          throw e;
        }
        const id = await this.addReminder({ kind: "custom", title: i.title, dueAt: at, source: "chat" });
        return { ok: true, id, at: i.localDateTime };
      },
      listUpcoming: (days) => {
        const until = new Date(this.now().getTime() + days * DAY).toISOString();
        const rows = this
          .db<ReminderRow>`SELECT * FROM reminders WHERE status = 'scheduled' AND kind != 'checkin' AND due_at <= ${until} ORDER BY due_at LIMIT 8`;
        return {
          ok: true,
          items: rows.map((r) => ({
            id: r.id,
            title: r.title.slice(0, 60),
            at: `${utcToLocal(r.due_at, this.tz).date} ${utcToLocal(r.due_at, this.tz).time}`,
          })),
        };
      },
      cancelReminder: async (id) => ({ ok: await this.cancelReminderById(id) }),
      startStudyPlan: async ({ topics, ...rest }) => ({
        ok: true,
        ...(await this.beginPlan(planRequest.parse({ ...rest, material: topics ?? this.pastedMaterial() }))),
      }),
      logQuizResult: (i) => {
        // A result is only valid after the quiz happened: one assistant turn per question has to exist already.
        const turns = (this.messages as UIMessage[]).slice(-40).filter((m) => m.role === "assistant").length;
        if (turns < Math.max(2, i.total))
          throw new Error("The quiz is not finished. Ask the questions one at a time first; call this only after the last answer is graded.");
        this
          .db`INSERT INTO quiz_results (id, topic, course_id, correct, total, created_at) VALUES (${newId()}, ${i.topic}, ${null}, ${i.correct}, ${i.total}, ${this.now().toISOString()})`;
        return { ok: true, memory: applyQuizResult(this.db, i.topic, i.correct, i.total, this.now()) };
      },
    };
  }

  /** Did the student really say these words in their last two messages? (whitespace, case and punctuation ignored) */
  private studentSaid(words: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const recent = (this.messages as UIMessage[])
      .filter((m) => m.role === "user")
      .slice(-2)
      .map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" "))
      .join(" ");
    const needle = norm(words);
    return needle.length > 0 && norm(recent).includes(needle);
  }

  /** Longest recent student message that looks like a topic list (3+ items), used when the model passed no topics. */
  private pastedMaterial(): string {
    const items = (t: string) => t.split(/[\n,;•]+/).filter((x) => x.trim().length >= 3).length;
    const best = (this.messages as UIMessage[])
      .filter((m) => m.role === "user")
      .slice(-10)
      .map((m) =>
        m.parts
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("\n")
          .trim(),
      )
      .filter((t) => t.length >= 40 && items(t) >= 3)
      .sort((a, b) => b.length - a.length)[0];
    if (!best) throw new Error("No syllabus found. Ask the student to paste their topics or syllabus first.");
    return best.slice(0, LIMITS.materialChars);
  }

  // ---------- onboarding and profile ----------
  @callable()
  async completeOnboarding(raw: unknown) {
    const i = check(onboardingInput, raw);
    this.patch({
      profile: { ...this.state.profile, displayName: i.displayName, timezone: i.timezone, checkInTime: i.checkInTime, onboarded: true },
      courses: i.courses.map((c) => ({ id: newId(), ...c })),
    });
    await this.scheduleNextCheckIn();
    return { ok: true };
  }

  @callable()
  async updateProfile(raw: unknown) {
    const i = check(profileUpdate, raw);
    const rearm = (i.timezone && i.timezone !== this.tz) || (i.checkInTime && i.checkInTime !== this.state.profile.checkInTime);
    this.patch({
      profile: {
        ...this.state.profile,
        ...(i.displayName !== undefined && { displayName: i.displayName }),
        ...(i.timezone && { timezone: i.timezone }),
        ...(i.checkInTime && { checkInTime: i.checkInTime }),
        ...(i.voiceEnabled !== undefined && { voiceEnabled: i.voiceEnabled }),
      },
      ...(i.courses && { courses: i.courses.map((c) => ({ id: this.state.courses.find((o) => o.name === c.name)?.id ?? newId(), ...c })) }),
    });
    if (rearm && this.state.profile.onboarded) await this.scheduleNextCheckIn();
    return { ok: true };
  }

  // ---------- memory ----------
  @callable()
  listMemoryRows() {
    return listMemories(this.db);
  }

  @callable()
  deleteMemory(raw: unknown) {
    const { memoryId } = check(memoryIdInput, raw);
    this.db`DELETE FROM memories WHERE id = ${memoryId}`;
    return { ok: true };
  }

  @callable()
  getUsage() {
    const since = new Date(this.now().getTime() - 30 * DAY).toISOString();
    return { since, rows: usageSince(this.db, since), today: this.usageToday(), caps: this.state.caps };
  }

  // ---------- reminders ----------
  private async addReminder(r: { kind: "custom" | "session" | "checkin"; title: string; dueAt: Date; source: string; body?: string }): Promise<string> {
    if (r.kind === "custom") {
      const [{ n }] = this.db<{ n: number }>`SELECT count(*) AS n FROM reminders WHERE kind = 'custom' AND status = 'scheduled'`;
      if (n >= LIMITS.reminderMaxScheduled) throw new ReminderError(`You already have ${n} reminders. Cancel some first.`);
    }
    const id = newId();
    const callback = r.kind === "checkin" ? "dailyCheckIn" : "fireReminder";
    const schedule = await this.schedule(r.dueAt, callback, { reminderId: id });
    this.db`INSERT INTO reminders (id, kind, title, due_at, schedule_id, status, source, body, created_at)
            VALUES (${id}, ${r.kind}, ${r.title}, ${r.dueAt.toISOString()}, ${schedule.id}, 'scheduled', ${r.source}, ${r.body ?? null}, ${this.now().toISOString()})`;
    this.refreshSnapshot();
    return id;
  }

  private async cancelReminderById(id: string): Promise<boolean> {
    const row = this.db<ReminderRow>`SELECT * FROM reminders WHERE id = ${id} AND status = 'scheduled'`[0];
    if (!row) throw new Error("Unknown reminder id");
    if (row.schedule_id) await this.cancelSchedule(row.schedule_id);
    this.db`UPDATE reminders SET status = 'cancelled' WHERE id = ${id}`;
    this.refreshSnapshot();
    return true;
  }

  @callable()
  async cancelReminder(raw: unknown) {
    const { reminderId } = check(z.object({ reminderId: z.string() }), raw);
    return { ok: await this.cancelReminderById(reminderId) };
  }

  /** Schedule callback. Idempotent: a row that is not 'scheduled' (already sent or cancelled) is ignored. */
  async fireReminder(payload: { reminderId: string }) {
    const row = this.db<ReminderRow>`SELECT * FROM reminders WHERE id = ${payload.reminderId}`[0];
    if (!row || row.status !== "scheduled") return;
    this.db`UPDATE reminders SET status = 'sent' WHERE id = ${row.id}`;
    const now = this.now();
    await this.postAssistant(reminderMessage(row.title, row.body, row.due_at, now));
    this.broadcast(JSON.stringify({ type: "sf_reminder", id: row.id, title: row.title, body: row.body ?? undefined }));
    this.refreshSnapshot();
  }

  /** Daily check-in: post the agenda, then re-arm for the next local occurrence (so DST stays correct). */
  async dailyCheckIn(payload: { reminderId: string }) {
    const row = this.db<ReminderRow>`SELECT * FROM reminders WHERE id = ${payload.reminderId}`[0];
    if (row && row.status === "scheduled") {
      this.db`UPDATE reminders SET status = 'sent' WHERE id = ${row.id}`;
      await this.postAssistant(this.agenda());
      this.broadcast(JSON.stringify({ type: "sf_reminder", id: row.id, title: "Daily check-in" }));
      this.prune();
    }
    await this.scheduleNextCheckIn();
  }

  private agenda(): string {
    const now = this.now();
    const end = new Date(now.getTime() + DAY).toISOString();
    const items = this.db<{ kind: string; title: string; due_at: string; duration_min: number | null }>`
      SELECT r.kind, r.title, r.due_at, s.duration_min FROM reminders r
      LEFT JOIN plan_sessions s ON s.reminder_id = r.id
      WHERE r.status = 'scheduled' AND r.kind != 'checkin' AND r.due_at <= ${end} ORDER BY r.due_at`;
    const weak = this.db<{ content: string }>`SELECT content FROM memories WHERE kind = 'weak_topic' ORDER BY updated_at DESC LIMIT 1`[0];
    return checkInMessage({
      now,
      timezone: this.tz,
      displayName: this.state.profile.displayName,
      items: items.map((i) => ({ kind: i.kind, title: i.title, dueAt: i.due_at, durationMin: i.duration_min ?? undefined })),
      exams: this.state.courses.flatMap((c) => (c.examDate ? [{ name: c.name, examDate: c.examDate }] : [])),
      weakTopic: weak?.content,
    });
  }

  /** Exactly one pending check-in: cancel any others first. */
  private async scheduleNextCheckIn() {
    for (const r of this.db<ReminderRow>`SELECT * FROM reminders WHERE kind = 'checkin' AND status = 'scheduled'`) {
      if (r.schedule_id) await this.cancelSchedule(r.schedule_id);
      this.db`UPDATE reminders SET status = 'cancelled' WHERE id = ${r.id}`;
    }
    const at = nextLocalOccurrence(this.state.profile.checkInTime, this.tz, this.now());
    await this.addReminder({ kind: "checkin", title: "Daily check-in", dueAt: at, source: "system" });
  }

  private prune() {
    const now = this.now().getTime();
    this.db`DELETE FROM llm_usage WHERE ts < ${new Date(now - 90 * DAY).toISOString()}`;
    this.db`DELETE FROM quiz_results WHERE created_at < ${new Date(now - 365 * DAY).toISOString()}`;
    this.db`DELETE FROM reminders WHERE status != 'scheduled' AND due_at < ${new Date(now - 30 * DAY).toISOString()}`;
  }

  /** Recompute the `upcoming` list in synced state (only broadcasts when it changed). */
  private refreshSnapshot() {
    const rows = this.db<ReminderRow>`SELECT * FROM reminders WHERE status = 'scheduled' ORDER BY due_at LIMIT 10`;
    const upcoming: UpcomingItem[] = rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, dueAt: r.due_at }));
    if (JSON.stringify(upcoming) !== JSON.stringify(this.state.upcoming)) this.patch({ upcoming });
  }

  /** Append an assistant message without calling the model (reminders, check-ins). */
  private async postAssistant(text: string) {
    await this.waitUntilStable({ timeout: 10_000 });
    const msg: UIMessage = { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text }] };
    await this.persistMessages([...(this.messages as UIMessage[]), msg]);
  }

  // ---------- study plans ----------
  @callable()
  async startPlan(raw: unknown) {
    return this.beginPlan(check(planRequest, raw));
  }

  private async beginPlan(req: z.infer<typeof planRequest>): Promise<{ planId: string }> {
    const now = this.now();
    const here = utcToLocal(now, this.tz);
    if (this.usageToday().planStarts >= this.state.caps.planStarts) throw new Error("Daily plan limit reached; try again tomorrow.");
    if (this.db`SELECT 1 AS x FROM plans WHERE status IN ('generating','awaiting_approval')`.length)
      throw new Error("Finish or reject the current plan first.");
    const days = daysBetween(here.date, req.examDate);
    if (days < 1 || days > LIMITS.planMaxAheadDays) throw new Error(`Exam date must be 1-${LIMITS.planMaxAheadDays} days from today.`);

    let course = this.state.courses.find((c) => c.name.toLowerCase() === req.courseName.toLowerCase());
    let courses = this.state.courses;
    if (!course) {
      if (courses.length >= LIMITS.courses) throw new Error("Too many courses; remove one in Settings.");
      course = { id: newId(), name: req.courseName, examDate: req.examDate };
      courses = [...courses, course];
    }
    const planId = newId();
    this.db`INSERT INTO plans (id, course_id, course_name, exam_date, status, request_json, created_at)
            VALUES (${planId}, ${course.id}, ${req.courseName}, ${req.examDate}, 'generating', ${JSON.stringify({ ...req, material: undefined })}, ${now.toISOString()})`;
    this.bump({ planStarts: 1 });
    this.patch({ courses, activePlan: { id: planId, courseId: course.id, status: "generating", progress: 0.05, message: "Reading your material…" } });

    const params: PlanParams = {
      planId,
      courseName: req.courseName,
      examDate: req.examDate,
      material: req.material,
      minutesPerDay: req.minutesPerDay,
      sessionMinutes: req.sessionMinutes,
      preferredTime: req.preferredTime,
      timezone: this.tz,
      today: here.date,
      nowLocalTime: here.time,
    };
    try {
      const workflowId = await this.runWorkflow("STUDY_PLAN_WORKFLOW", params, { metadata: { planId } });
      this.db`UPDATE plans SET workflow_id = ${workflowId} WHERE id = ${planId}`;
      this.setPlanState(planId, "generating", { workflowId });
    } catch (e) {
      this.markPlan(planId, "failed", "Could not start the plan. Please try again.");
      throw e;
    }
    return { planId };
  }

  /** Keep SQL status and the synced `activePlan` in step. */
  private markPlan(planId: string, status: PlanStatus, message?: string) {
    this.db`UPDATE plans SET status = ${status}, note = ${message ?? null}, decided_at = ${this.now().toISOString()} WHERE id = ${planId}`;
    this.setPlanState(planId, status, { message });
  }
  private setPlanState(planId: string, status: PlanStatus, extra: { workflowId?: string; message?: string; progress?: number } = {}) {
    const row = this.db<PlanRow>`SELECT * FROM plans WHERE id = ${planId}`[0];
    if (!row) return;
    const prev = this.state.activePlan?.id === planId ? this.state.activePlan : undefined;
    this.patch({
      activePlan: {
        id: planId,
        courseId: row.course_id,
        status,
        workflowId: extra.workflowId ?? row.workflow_id ?? prev?.workflowId,
        message: extra.message,
        progress: extra.progress ?? (status === "awaiting_approval" ? 0.7 : prev?.progress),
      },
    });
  }

  /** RPC from the workflow: store the proposal for the student to review. */
  async savePlanProposal(planId: string, topics: Topic[], result: PlanResult, usage: { input: number; output: number }) {
    const plan = this.db<PlanRow>`SELECT * FROM plans WHERE id = ${planId}`[0];
    if (!plan || plan.status !== "generating") return;
    this.db`DELETE FROM plan_sessions WHERE plan_id = ${planId}`;
    for (const s of result.sessions.slice(0, LIMITS.sessionsMax)) {
      this
        .db`INSERT INTO plan_sessions (id, plan_id, starts_at, duration_min, kind, topic, objective) VALUES (${newId()}, ${planId}, ${s.startsAt}, ${s.durationMin}, ${s.kind}, ${s.topic}, ${s.objective})`;
    }
    const note = result.overloaded
      ? `Heavy plan: topics were grouped to fit.${result.suggestedMinutesPerDay ? ` About ${result.suggestedMinutesPerDay} min/day would avoid that.` : ""}`
      : null;
    this
      .db`UPDATE plans SET topics_json = ${JSON.stringify(topics)}, overloaded = ${result.overloaded ? 1 : 0}, note = ${note}, status = 'awaiting_approval' WHERE id = ${planId}`;
    recordUsage(this.db, { feature: "plan_extract", model: LLAMA, input: usage.input, output: usage.output }, this.now());
    this.bump({ inputTokens: usage.input, outputTokens: usage.output });
    this.setPlanState(planId, "awaiting_approval", { message: note ?? "Review your plan", progress: 0.7 });
  }

  @callable()
  async decidePlan(raw: unknown) {
    const i = check(decidePlanInput, raw);
    const plan = this.db<PlanRow>`SELECT * FROM plans WHERE id = ${i.planId}`[0];
    if (!plan || plan.status !== "awaiting_approval" || !plan.workflow_id) throw new Error("That plan is not waiting for approval.");
    if (i.approve) {
      await this.approveWorkflow(plan.workflow_id, { reason: i.reason });
      this.setPlanState(plan.id, "awaiting_approval", { message: "Scheduling your sessions…", progress: 0.85 });
    } else {
      await this.rejectWorkflow(plan.workflow_id, { reason: i.reason });
      this.setPlanState(plan.id, "awaiting_approval", { message: "Discarding…" });
    }
    return { ok: true };
  }

  /** RPC from the workflow after approval: one reminder per future session, replacing any older active plan. */
  async activatePlan(planId: string) {
    const plan = this.db<PlanRow>`SELECT * FROM plans WHERE id = ${planId}`[0];
    if (!plan || plan.status === "active") return; // replays are no-ops
    for (const old of this.db<PlanRow>`SELECT * FROM plans WHERE status = 'active'`) await this.closePlanSessions(old.id, "completed");
    const nowMs = this.now().getTime();
    const sessions = this.db<{ id: string; starts_at: string; duration_min: number; kind: string; topic: string; objective: string | null }>`
      SELECT id, starts_at, duration_min, kind, topic, objective FROM plan_sessions WHERE plan_id = ${planId} AND reminder_id IS NULL ORDER BY starts_at`;
    for (const s of sessions) {
      if (Date.parse(s.starts_at) < nowMs + 60_000) continue;
      const title = `${s.kind === "review" ? "Review" : s.kind === "final" ? "Final prep" : "Study"}: ${s.topic}`;
      const rid = await this.addReminder({
        kind: "session",
        title,
        dueAt: new Date(s.starts_at),
        source: `plan:${planId}`,
        body: `${s.objective ?? ""} (${s.duration_min} min)`.trim(),
      });
      this.db`UPDATE plan_sessions SET reminder_id = ${rid} WHERE id = ${s.id}`;
    }
    this.markPlan(planId, "active");
    this.refreshSnapshot();
  }

  /** RPC from the workflow: the student rejected the plan or the approval timed out. */
  async closePlan(planId: string, status: "rejected" | "expired") {
    await this.closePlanSessions(planId, status);
    this.markPlan(planId, status, status === "expired" ? "The plan expired before it was approved." : undefined);
  }

  /** Cancel every scheduled reminder that belongs to a plan. */
  private async closePlanSessions(planId: string, status: PlanStatus) {
    for (const r of this
      .db<ReminderRow>`SELECT r.* FROM reminders r JOIN plan_sessions s ON s.reminder_id = r.id WHERE s.plan_id = ${planId} AND r.status = 'scheduled'`) {
      if (r.schedule_id) await this.cancelSchedule(r.schedule_id);
      this.db`UPDATE reminders SET status = 'cancelled' WHERE id = ${r.id}`;
    }
    this.db`UPDATE plans SET status = ${status} WHERE id = ${planId}`;
    this.refreshSnapshot();
  }

  @callable()
  getPlan(raw: unknown) {
    const { planId } = check(planIdInput, raw);
    const plan = this.db<PlanRow>`SELECT * FROM plans WHERE id = ${planId}`[0];
    if (!plan) throw new Error("Unknown plan");
    const sessions = this
      .db`SELECT id, starts_at, duration_min, kind, topic, objective, status FROM plan_sessions WHERE plan_id = ${planId} ORDER BY starts_at`;
    return {
      plan: { id: plan.id, courseName: plan.course_name, examDate: plan.exam_date, status: plan.status, overloaded: !!plan.overloaded, note: plan.note },
      sessions,
    };
  }

  @callable()
  markSession(raw: unknown) {
    const i = check(markSessionInput, raw);
    const row = this.db<{ plan_id: string }>`SELECT plan_id FROM plan_sessions WHERE id = ${i.sessionId}`[0];
    if (!row) throw new Error("Unknown session");
    this.db`UPDATE plan_sessions SET status = ${i.status} WHERE id = ${i.sessionId}`;
    const [{ pending }] = this.db<{ pending: number }>`SELECT count(*) AS pending FROM plan_sessions WHERE plan_id = ${row.plan_id} AND status = 'pending'`;
    if (!pending && this.state.activePlan?.id === row.plan_id) this.markPlan(row.plan_id, "completed");
    return { ok: true };
  }

  // Workflow callbacks ------------------------------------------------------------
  async onWorkflowProgress(_name: string, workflowId: string, progress: unknown) {
    const p = progress as { percent?: number; message?: string };
    const plan = this.db<PlanRow>`SELECT * FROM plans WHERE workflow_id = ${workflowId}`[0];
    if (plan && plan.status === "generating") this.setPlanState(plan.id, "generating", { progress: p.percent, message: p.message });
  }
  async onWorkflowError(_name: string, workflowId: string, error: string) {
    const plan = this.db<PlanRow>`SELECT * FROM plans WHERE workflow_id = ${workflowId}`[0];
    // Show the friendly NonRetryable messages; hide anything internal.
    const friendly =
      /topics|exam|too many|plan/i.test(error) && error.length < 200 ? error : "Something went wrong while building your plan. Please try again.";
    if (plan && (plan.status === "generating" || plan.status === "awaiting_approval")) this.markPlan(plan.id, "failed", friendly);
  }

  // ---------- voice (called by VoiceInputAgent over RPC; not client-callable) ----------
  voiceSecondsLeft(): number {
    const { features, profile, caps } = this.state;
    if (!features.voice || !profile.voiceEnabled) return 0;
    return Math.max(0, caps.voiceSeconds - this.usageToday().voiceSeconds);
  }
  recordVoice(seconds: number) {
    const s = Math.max(0, Math.min(60, Math.ceil(seconds)));
    recordUsage(this.db, { feature: "voice", model: NOVA, audioSeconds: s }, this.now());
    this.bump({ voiceSeconds: s });
  }

  // ---------- account ----------
  /** Called by the Worker for POST /api/account/delete. Cancels everything, then wipes all storage. */
  async deleteAllData() {
    await this.waitUntilStable({ timeout: 5_000 }); // let an in-flight chat turn finish so its keep-alive is released before the wipe
    for (const s of await this.listSchedules()) await this.cancelSchedule(s.id);
    for (const p of this.db<PlanRow>`SELECT * FROM plans WHERE workflow_id IS NOT NULL AND status IN ('generating','awaiting_approval')`) {
      try {
        await this.terminateWorkflow(p.workflow_id!);
      } catch {
        // already finished
      }
    }
    await this.destroy();
  }
}
