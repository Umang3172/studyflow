import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { modelSchema, slim, studyTools, toolsFor, type ToolHost } from "../../src/lib/tools.ts";
import { createReminderInput, planToolInput } from "@studyflow/shared";

describe("slim schemas for the model, full validation on the server", () => {
  it("slim() removes validation-only keywords at every depth and keeps structure", () => {
    const out = slim({
      $schema: "x",
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string", pattern: "^x$", maxLength: 5, description: "keep" } },
      required: ["a"],
    });
    expect(out).toEqual({ type: "object", properties: { a: { type: "string", description: "keep" } }, required: ["a"] });
  });

  it("the model-facing schema is small but zod still rejects bad input", async () => {
    const schema = asSchema(modelSchema(createReminderInput));
    expect(JSON.stringify(schema.jsonSchema)).not.toContain("pattern");
    expect(schema.jsonSchema).toMatchObject({ required: expect.arrayContaining(["title", "localDateTime", "when"]) });
    const bad = await schema.validate!({ title: "x", localDateTime: "tomorrow 9am", when: "tomorrow" });
    expect(bad.success).toBe(false);
    const good = await schema.validate!({ title: "x", localDateTime: "2026-10-10T10:00", when: "Saturday" });
    expect(good.success).toBe(true);
  });

  it("the chat plan tool takes only course, exam date, minutes and optional topics", async () => {
    const schema = asSchema(modelSchema(planToolInput));
    expect(Object.keys((schema.jsonSchema as { properties: object }).properties).sort()).toEqual(["courseName", "examDate", "minutesPerDay", "topics"]);
    expect((await schema.validate!({ courseName: "OS", examDate: "2026-10-30", minutesPerDay: 10 })).success).toBe(false); // below the 30 minute floor
    expect((await schema.validate!({ courseName: "OS", examDate: "2026-10-30", minutesPerDay: 90 })).success).toBe(true);
  });

  it("tool execute() turns host errors into {ok:false} results instead of throwing", async () => {
    const host = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("boom");
        },
      },
    ) as ToolHost;
    const tools = studyTools(host);
    const out = await tools.listUpcoming.execute!({ days: 3 }, { toolCallId: "t", messages: [] } as never);
    expect(out).toEqual({ ok: false, error: "boom" });
  });
});

describe("toolsFor: only offer the tools a conversation needs", () => {
  it("offers nothing for explanations, greetings and small talk", () => {
    for (const text of ["Explain how paging works", "Hi! Say hello in five words.", "What is a mutex?", "thanks, that makes sense"]) {
      // "What is" is deliberately broad (schedule questions) so it may offer listUpcoming; nothing else is allowed
      expect(
        toolsFor(text, []).filter((t) => t !== "listUpcoming"),
        text,
      ).toEqual([]);
    }
  });

  it("offers the right tool for each kind of request", () => {
    expect(toolsFor("Remind me tomorrow at 7pm to revise", [])).toContain("createReminder");
    expect(toolsFor("set an alarm for 3pm", [])).toContain("createReminder");
    expect(toolsFor("What's coming up this week?", [])).toContain("listUpcoming");
    expect(toolsFor("please cancel that reminder", [])).toContain("cancelReminder");
    expect(toolsFor("make me a study plan for my exam", [])).toContain("startStudyPlan");
    expect(toolsFor("Quiz me on deadlocks", [])).toContain("logQuizResult");
    expect(toolsFor("My goal is to get an A", [])).toContain("remember");
    expect(toolsFor("I always get confused by deadlock detection", [])).toContain("remember");
  });

  it("keeps a tool that was just used, so a pending approval can still resolve", () => {
    expect(toolsFor("yes, go ahead", ["startStudyPlan"])).toEqual(["startStudyPlan"]);
  });

  it("keeps the conversation going when the student answers a follow-up question", () => {
    // The model asked "When should I remind you?"; the student's answer alone has no keyword, so the recent text is searched.
    expect(toolsFor("remind me to call my study group\nWhen should I remind you?\ntomorrow at 6pm", [])).toContain("createReminder");
  });

  it("offers far fewer tool tokens than all six on a typical turn", () => {
    expect(toolsFor("Explain how paging works", []).length).toBeLessThanOrEqual(1);
  });
});
