# Studyflow Handoff (for the next coding session)

**State (2026-10-08):** the MVP is built (PLAN.md milestones M0-M5 in code) and verified **with a mock model**. It has not run against real Workers AI and has not been deployed: both need the user's Cloudflare login (PLAN A9). Setup, run, test and deploy commands are in [README.md](README.md); spike results and API findings are in [docs/spikes.md](docs/spikes.md). You should not need the build transcript; it is archived in the README appendix.

## What to do next (in this order)

1. **Real-model pass** (user runs `npx wrangler login`): start `npm run dev -w apps/api` (not the mock) and run `node apps/api/evals/run.mjs --write`. Commit `docs/evals.md`. Fix prompt or tool-description problems it finds (reminder date parsing is the one most likely to need work; target at least 85%). In the same session, compare `llm_usage.input_tokens` with the estimates and adjust `DIVISOR` in `apps/api/src/lib/budget.ts` if the error is over 15%, then fill the README "Application runtime usage" table from real rows.
2. **Deploy** per README, then run the smoke test listed there. Confirm the WebSocket upgrade works on deployed Pages (S1 was proven locally with `wrangler pages dev`).
3. **Voice** on a real device: Chrome and Safari dictation, 60 s call cap, daily cap (`docs/spikes.md` S4).
4. Optional, not started: Playwright E2E and axe pass, GitHub Actions CI (`npm ci`, `npm run check`, `npm test`), Web Push, Llama Guard, passkeys, file upload.

## What exists

```text
apps/api/src/index.ts                 entry: /api/session, /api/health, /api/account/delete, /agents/study*, /agents/voice*
apps/api/src/agents/study-agent.ts    StudyAgent (AIChatAgent): chat, tools, memory, reminders, plans, usage, caps
apps/api/src/agents/voice-input-agent.ts   dictation; asks StudyAgent for the daily allowance over RPC
apps/api/src/workflows/study-plan.ts  extract -> allocate -> save proposal -> wait for approval -> activate
apps/api/src/lib/                     time, planner, auth, budget, prompts, context, history (rolling summary), memory,
                                      reminders, tools, extract, usage, db (schema), model, mock-model
apps/api/test/{unit,integration}/     93 tests, run in workerd via @cloudflare/vitest-plugin
apps/api/evals/run.mjs                real-model golden prompts (needs a running real dev server)
apps/api/wrangler.jsonc               production config (has the remote `ai` binding)
apps/api/wrangler.mock.jsonc          identical but without `ai`, for tests and `npm run dev:mock`; keep the two in sync
apps/web/                             React SPA (Chat, Today, Plan, Memory, Settings, Onboarding, Dictation), Pages Function proxy, _headers
packages/shared/                      zod schemas, state type, limits, Gantt source generator
```

## Non-negotiables (unchanged)

- Model `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (24k context). Always set `maxOutputTokens`.
- The client never chooses its agent instance. The Worker maps the signed `sf_session` cookie to `getAgentByName(env.StudyAgent, userId)`. Never expose `routeAgentRequest` to public traffic. Agents do **not** send their identity to clients (`sendIdentityOnConnect: false`).
- `validateStateChange` rejects every non-server write; mutations go through zod-validated `@callable` methods; zod at every trust boundary.
- Reminders: compute UTC from the student's IANA timezone, `schedule(Date, …)`, re-arm the daily check-in from its own callback.
- No secrets in git. Never handle the user's Cloudflare or GitHub credentials. Ask before deviating from Pages (D4), adding dependencies beyond PLAN §12, or installing agent plugins or hooks.
- Keep README.md current (see below).

## Deviations from PLAN.md (and why)

| PLAN | Built | Why |
| --- | --- | --- |
| §12 dependency list | Also pinned: `@modelcontextprotocol/client` 2.0.0, `/sdk` 1.30.0, `/server` 2.0.0 (API and web), `@babel/core` 7.29.0, `@ai-sdk/provider` 4.0.25, `@types/react` and `@types/react-dom` 19.3.0. `@cloudflare/voice` not installed. | The MCP trio are required peers of `agents@0.27.0` and imported at load; `@babel/core` is needed by `agents/vite`; voice symbols are exported from `agents/voice*`. The rest are type-only. `.npmrc` sets `legacy-peer-deps=true` because npm 10.9 crashes resolving this tree, so peers must be listed by hand. |
| §14 unit tests in node | All tests run in workerd (one Vitest config), against `wrangler.mock.jsonc` | The `ai` binding forces a remote proxy session that needs credentials; one runner is simpler. |
| §5.5 allocator: reviews can take any slot | Learning has priority; reviews may use at most half the day's slots (rounded down) while topics remain, then any free slot. Tiers: reviews +1/+3/+7, then +1/+3, +1, none, then group topics (2, then as many as fit) which sets `overloaded`. | The first version made a roomy plan "overloaded" because reviews starved learning (caught by a test). |
| §8.3 `startStudyPlan` takes a full `PlanRequest` | Chat tool takes course, exam date, minutes, optional session/time and an optional short `topics` string (≤600 chars). A pasted syllabus is read by the server from recent chat history and must look like a list (3+ items). The Plan form still sends full `material`. | The model no longer copies up to 12,000 characters into a tool call (output cap 1,024 tokens) and plans cannot start from the request sentence itself. |
| not in plan | **Rolling summary** (`lib/history.ts`, `chat_summary` table), cleared with the chat | Requested for this build: cheaper long chats. |
| §5.7 `forceEndCall` after 60 s | `connection.close(4000)` after 60 s, and the client stops the mic at 60 s | `withVoiceInput` has no `forceEndCall`. |
| §5.7 voice usage in the voice agent | Allowance and usage live in `StudyAgent` (`voiceSecondsLeft`, `recordVoice` over RPC) | One source of truth for the daily cap and the `llm_usage` rows. |
| §5.4 reminder cap 100 scheduled | The cap applies to `custom` reminders only; plan sessions (up to 120) and the one check-in are exempt | A 120-session plan could not otherwise be scheduled. |
| §5.4 check-in separate | The check-in is a `reminders` row (`kind = 'checkin'`) whose schedule callback is `dailyCheckIn` | One uniform `upcoming` list and idempotent re-arm. |
| §5.6 state | Adds `usageToday.inputTokens/outputTokens` and `features.voice` | Live token counters and the voice feature flag in the UI. |
| §3 D9 Gantt per session | One bar per topic (first learn → last review) plus the final day | Per-session bars were unreadable (up to 120 rows). |

## Gotchas found while building

- Extend `agents/tsconfig` and never set `experimentalDecorators`. The Vitest config needs the `agents/vite` plugin (decorators); the web app does not (it imports only `agents/react`).
- The vitest pool starts a remote proxy session for any `ai` binding, which fails without credentials. Use `wrangler.mock.jsonc`.
- AI SDK 7: `isStepCount` (alias `stepCountIs`), `repairToolCall`, usage is `{ inputTokens, outputTokens }`, `createUIMessageStream` for canned replies. The 800-token tool budget is measured on `z.toJSONSchema` output (which includes a `$schema` URL per tool), so it is conservative; the exact provider payload was not inspected.
- `useAgentChat` suspends while loading history. Keep its `Suspense` boundary **below** `useAgent` (above it, React runs the connection hook's cleanup and the screen goes blank).
- The SDK handles the chat-clear message before `onMessage`; hook `resetTurnState()` (it runs only on clear) to drop per-chat state.
- `destroy()` aborts the Durable Object, so the Worker's account-delete handler expects and ignores an error from `deleteAllData()`.
- Agent state broadcasts to every client: keep it small and server-written (`usageToday` changes on every turn; that is intentional but is the largest churn).
- `wrangler dev` does not run Workflow `pause/resume/terminate/restart`; `deleteAllData()` swallows `terminateWorkflow` errors.
- The web bundle is about 1 MB (320 KB gzip) before Mermaid, which is lazy-loaded. Most of it is Streamdown, React, the agents client and the zod schemas; lazy-loading Streamdown would be the easy win.
- Mermaid's x-axis labels are tight on narrow panels (the chart scrolls horizontally); a custom React timeline would look better if this matters.
- `npm audit` reports advisories in dev-only `sharp` (via miniflare) and in `katex` (via Mermaid). Mermaid runs with `securityLevel: "strict"` on text generated by our code; revisit when upstream patches land.

## Maintaining README

After each milestone or session:

1. Add a phase entry (session id + UTC start) to `docs/dev-phases.json`.
2. Run `python3 scripts/sync_readme_log.py --stage "<what was just completed>"`. This regenerates the stage line, the dev-usage table and the verbatim conversation appendix, with secrets redacted.
3. Update "Application runtime usage" only from real `llm_usage` data. It stays "unavailable" until the app has run against Workers AI.

If transcripts are not available (another tool, or a different machine), record figures as "unavailable".

## Commands

```bash
npm ci
npm run dev:mock -w apps/api   # Worker :8787 with the mock model (no login)
npm run dev -w apps/api        # Worker :8787 with real Workers AI (needs wrangler login)
npm run dev -w apps/web        # Vite :5173, proxies /agents (ws) and /api
npm test                       # 93 tests in workerd
npm run check                  # oxlint, oxfmt --check, tsc (api + web)
```

## Coding guidance (Ponytail principles, unchanged)

1. Before editing, list everything the change must reach (callers, tests, fixtures, config, exports) and what it could break or expose. That list is the scope.
2. Pick the first option that fully works: skip what nobody asked for → reuse the repo → use the platform (Agents SDK, Web APIs, `Intl`) → use an installed dependency → write one readable line → only then write the minimum new code.
3. No speculative abstractions, options or wrappers. Never cut validation, security, data-loss handling or accessibility.
4. Non-trivial logic ships with a small test. A deliberate shortcut gets a `// ponytail: <limit>, upgrade when <condition>` comment.
5. Finish with a note of what you skipped or did not verify.
