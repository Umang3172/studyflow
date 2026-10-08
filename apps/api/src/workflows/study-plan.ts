import { AgentWorkflow, WorkflowRejectedError } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { hhmm, ianaTimezone, id, ymd, LIMITS } from "@studyflow/shared";
import type { StudyAgent } from "../agents/study-agent.ts";
import { extractTopics, NoTopicsError } from "../lib/extract.ts";
import { chatModel } from "../lib/model.ts";
import { allocate, PlanError } from "../lib/planner.ts";

// extract (LLM) -> allocate (pure) -> save proposal -> wait for the student -> activate (schedule reminders).
// Side effects live inside step.do; step names are fixed; payload is never mutated.

const paramsSchema = z.object({
  planId: id,
  courseName: z.string().min(1).max(LIMITS.courseNameChars),
  examDate: ymd,
  material: z.string().min(1).max(LIMITS.materialChars),
  minutesPerDay: z.number().int().min(30).max(240),
  sessionMinutes: z.number().int().min(25).max(90),
  preferredTime: hhmm,
  timezone: ianaTimezone,
  today: ymd,
  nowLocalTime: hhmm,
});
export type PlanParams = z.infer<typeof paramsSchema>;

const RETRY = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

export class StudyPlanWorkflow extends AgentWorkflow<StudyAgent, PlanParams> {
  async run(event: AgentWorkflowEvent<PlanParams>, step: AgentWorkflowStep) {
    const parsed = paramsSchema.safeParse(event.payload);
    if (!parsed.success) throw new NonRetryableError("invalid workflow params");
    const p = parsed.data;

    const extracted = await step.do("extract-topics", RETRY, async () => {
      try {
        return await extractTopics(chatModel(this.env), p);
      } catch (e) {
        if (e instanceof NoTopicsError) throw new NonRetryableError(e.message);
        throw e;
      }
    });
    await this.reportProgress({ step: "extract-topics", status: "complete", percent: 0.4, message: `Found ${extracted.topics.length} topics` });

    const allocation = await step.do("allocate-sessions", async () => {
      try {
        return allocate({ ...p, topics: extracted.topics });
      } catch (e) {
        if (e instanceof PlanError) throw new NonRetryableError(e.message);
        throw e;
      }
    });

    await step.do("save-proposal", async () => {
      await this.agent.savePlanProposal(p.planId, extracted.topics, allocation, extracted.usage);
    });
    await this.reportProgress({ step: "save-proposal", status: "complete", percent: 0.7, message: "Plan ready for review" });

    try {
      await this.waitForApproval(step, { timeout: "3 days" });
    } catch (e) {
      const rejected = e instanceof WorkflowRejectedError;
      await step.do("close-unapproved", async () => {
        await this.agent.closePlan(p.planId, rejected ? "rejected" : "expired");
      });
      await step.reportComplete({ planId: p.planId, status: rejected ? "rejected" : "expired" });
      return;
    }

    await step.do("activate", async () => {
      await this.agent.activatePlan(p.planId);
    });
    await step.reportComplete({ planId: p.planId, status: "active" });
  }
}
