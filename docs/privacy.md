# Privacy notes (college students)

Not legal advice. This describes what the code does today and what to decide before a public launch. Facts about Cloudflare come from its documentation (checked 2026-10-08): [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/) and [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/).

## What Studyflow stores

| Data | Where | Retention |
| --- | --- | --- |
| Anonymous session cookie `sf_session` (random user id plus signature; HttpOnly, SameSite=Lax, Secure on https) | Browser | 400 days, or until the student deletes data or clears site data |
| Chat history (up to the newest 400 messages), rolling summary, memories (max 50 short facts), study plans, reminders, quiz results, per-call token counts | One SQLite Durable Object per student | Chat: newest 400 messages. Token counts: 90 days. Quiz results: 365 days. Sent reminders: 30 days. Everything else until deleted. |
| Optional display name, time zone, courses and exam dates | Same object | Until deleted |
| Application logs (Workers observability is on, which records request metadata and errors; the app code never logs message text, transcripts or memories) | Cloudflare Workers logs | Cloudflare's retention for Workers Logs |

Not collected: email, phone number, student or institution id, location, advertising or analytics identifiers. There are no third-party scripts, fonts or trackers (the CSP only allows the app's own origin).

## Where student content goes

- **Cloudflare Workers AI** processes each prompt (system prompt, the student's context block, recent chat, pasted syllabus text) and the reply. Voice dictation sends audio to Deepgram Nova-3 hosted on Workers AI; audio is not stored by Studyflow.
- Cloudflare's documentation says Workers AI inputs and outputs are the customer's content, are not made available to other customers, and are not used to train or improve models without explicit consent.
- Studyflow's own data lives in Cloudflare Durable Object storage. By default an object is placed near the first request and never moves.

## Deletion and access

- **Delete all my data** (Settings) cancels every schedule and workflow, wipes the object's storage including chat history, and clears the cookie. It is tested end to end (`apps/web/e2e/app.spec.ts`, `apps/api/test/integration/agent.test.ts`).
- The Memory panel shows every remembered fact with a Forget button; Settings shows per-feature AI usage.
- There is no export button yet. If a regulator or an institution asks for one, add a callable that returns the student's rows as JSON.

## Things to decide before a public launch with college students

1. **Minimum age and terms.** College students are mostly adults, but some are 16 or 17. Pick a minimum age with counsel and state it in the terms; the app collects no personal identifiers, which keeps the exposure small but not zero.
2. **EU or UK students (GDPR/UK GDPR).** Deletion exists; consider pinning storage to the EU with `env.StudyAgent.jurisdiction("eu")` in `apps/api/src/index.ts` (not implemented: it changes where existing students' objects live, so decide before launch, not after). Note that the Durable Object id is still logged outside the jurisdiction for billing and debugging, per Cloudflare. Add a privacy policy page and a lawful-basis statement (consent at onboarding is the simplest).
3. **Institutional use.** If a university deploys Studyflow for its courses, student work can become part of education records (FERPA in the US) and the institution will want a data processing agreement. Independent student use of their own notes is outside that, but tell students not to paste other people's personal information (the in-app notice says so).
4. **Academic integrity.** The tutor refuses to produce graded work for submission and offers outlines, feedback and practice instead. Tell students the model can be wrong and that they should verify facts.
5. **Wellbeing.** The prompt tells the model to respond kindly to stress and to point to emergency services or a crisis line for self-harm or danger. It is not a counselling tool, and the wording of that disclaimer belongs in the terms.
6. **Spam and abuse.** Anonymous sessions can be minted by anyone: per-IP limits, per-student daily caps and a Workers AI spend alert are in place or listed in the README; Turnstile is a post-MVP option.
