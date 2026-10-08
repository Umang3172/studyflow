# Studyflow Handoff (for the next coding session)

**State (2026-10-08):** the MVP is built, **deployed** and verified on the real model. Live at https://studyflow-1ir.pages.dev (Pages SPA + Function → private Worker `studyflow-api` → Durable Objects, Workflows, Workers AI). Real-model evals: 12/12 ([docs/evals.md](docs/evals.md)); deployed smoke test: 10/10; 132 tests plus 19 Playwright/axe tests pass locally and in CI. Setup, run, test and deploy commands are in [README.md](README.md); spike results in [docs/spikes.md](docs/spikes.md); accessibility in [docs/a11y.md](docs/a11y.md); data handling in [docs/privacy.md](docs/privacy.md). You should not need the build transcript; it is archived in the README appendix.

## What is left (in this order)

1. **User, in the Cloudflare dashboard:** decide on Workers Paid (the free allocation is 10,000 neurons/day; a student at the daily cap uses about 2,600). A $1 billing budget alert ("StudyFlow Workers AI spend alert ($1)", email, enabled) was created on 2026-10-08. It is account-wide: Cloudflare's budget alert has no per-product field.
2. **Upstream issue:** `workers-ai-provider@4.0.0` doubles every streamed delta because Workers AI events now carry both OpenAI and native fields (`apps/api/src/lib/ai-binding.ts` works around it). Report it; remove the workaround when `test/unit/ai-binding.test.ts` ("the provider alone duplicates") starts failing.
3. **Before a public launch to college students** ([docs/privacy.md](docs/privacy.md)): decide the minimum age and write terms; consider pinning storage to the EU (`jurisdiction("eu")`) before any real EU users exist; add a privacy policy page.
4. **Manual checks nobody has done:** Safari and Firefox, screen readers (VoiceOver, NVDA) per docs/a11y.md, voice transcription quality.
5. Optional: Web Push, Llama Guard, passkeys, file upload, an automated deploy workflow (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets created by the user).

## Decisions made by the user (2026-10-08)

| Question | Decision |
| --- | --- |
| Q1 Pages vs Workers Static Assets | Moot for now: the Pages Function → service binding → Worker WebSocket path works in production. Revisit only if Pages Functions limits bite. Fallback is documented in PLAN D4. |
| Q3 who uses it | College students (mostly adults, some under 18): anonymous by design, no PII, data notice in the app, deletion works; see docs/privacy.md for the launch decisions that remain. |
| Q4 custom domain | No. The URL is `studyflow-1ir.pages.dev` (the name `studyflow` was taken). |
| Q5 Ponytail plugin | No; principles only (below). |
| Extra dependencies | Approved: the MCP trio, `@babel/core`, `@ai-sdk/provider`, `@types/react(-dom)`; later `@playwright/test`, `@axe-core/playwright`. |

## What exists

```text
apps/api/src/index.ts                 entry: /api/session, /api/health, /api/account/delete, /agents/study*, /agents/voice*
apps/api/src/agents/study-agent.ts    StudyAgent (AIChatAgent): chat, tools, memory, reminders, plans, usage, caps, guards
apps/api/src/agents/voice-input-agent.ts   dictation; asks StudyAgent for the daily allowance over RPC
apps/api/src/workflows/study-plan.ts  extract -> allocate -> save proposal -> wait for approval -> activate
apps/api/src/lib/                     time, planner, auth, budget, prompts, context, history (rolling summary), memory, reminders,
                                      tools (schemas, routing), extract, usage, db, model, ai-binding (provider workaround), mock-model
apps/api/test/{unit,integration}/     132 tests in workerd via @cloudflare/vitest-plugin
apps/api/evals/run.mjs, smoke.mjs     real-model golden prompts and an end-to-end smoke test; both take the deployed URL
apps/api/wrangler.jsonc               production config (remote `ai` binding, no public URL)
apps/api/wrangler.mock.jsonc          same without `ai` and with high rate limits, for tests, E2E and `npm run dev:mock`
apps/web/                             React SPA, Pages Function proxy, _headers (CSP), e2e/ (Playwright + axe)
packages/shared/                      zod schemas, state type, limits, Gantt source, leaked-tool-call stripper
.github/workflows/ci.yml              check + test + build; Playwright E2E and accessibility
```

## Non-negotiables (unchanged)

- Model `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (24k context). Always set `maxOutputTokens`.
- The client never chooses its agent instance. The Worker maps the signed `sf_session` cookie to `getAgentByName(env.StudyAgent, userId)`. Never expose `routeAgentRequest` to public traffic. Agents do not send their identity to clients.
- `validateStateChange` rejects every non-server write; mutations go through zod-validated `@callable` methods; zod at every trust boundary.
- Reminders: UTC from the student's IANA timezone, `schedule(Date, …)`, re-arm the daily check-in from its own callback.
- No secrets in git. Never handle the user's Cloudflare or GitHub credentials (`SESSION_SECRET` was generated and piped straight into `wrangler secret put`, never printed). Ask before deviating from Pages (D4), adding dependencies beyond PLAN §12 and the approved list, or installing agent plugins or hooks.
- Keep README.md current (see below).

## Lessons from the real-model run (the mock hid all of these)

1. **Doubled deltas.** Every streamed token and tool-call fragment arrived twice (see What is left, 2). Found by logging raw SSE from the binding with a temporary instrumented deploy and `wrangler tail`.
2. **Invented reminder times.** "remind me to call my study group" got 6 PM. Fix: `when` (the student's own words) must appear in the recent chat, checked server-side.
3. **Guessing around a rejection.** After "yesterday at 5pm" was refused the model retried with today. Fix: one rejected time locks `createReminder` for the rest of the turn.
4. **Premature quiz scoring** and hallucinated "you said deadlocks is weak". Fix: `logQuizResult` needs one assistant turn per question; prompt forbids claims not in the chat.
5. **Over-eager `remember`** saved greetings. Fix: `fact` removed from the tool's kinds; description says only self-stated goals, preferences, strengths, weak topics.
6. **Tool calls written into prose** ("Here is a function call: {...}"). Fixes: tools are only offered when the conversation needs them (`toolsFor`), and `stripLeakedToolCalls` removes calls to our tools at render time and before persistence. It still happens occasionally when a tool is on offer.
7. **Terse refusals.** "I can't help with that request." with no alternative. Fix: the integrity line requires a refusal plus an offer.
8. **Token cost.** Tool schemas were about 1,100 tokens per model step. Slim schemas (validation stays server-side) and routing took a first-turn question from 1,650 to 381 input tokens. The 3.5 chars/token estimator under-counted by 22%; it is 3.0 now.

Workflow that found these: run `apps/api/evals/run.mjs` against the deployed app, look at the actual frames with a throwaway debug client, change one thing, redeploy (allow about 20 s before the service binding serves the new version), rerun. Results vary by a case between runs; judge on several runs.

## Deviations from PLAN.md (and why)

| PLAN | Built | Why |
| --- | --- | --- |
| §12 dependency list | Also pinned: MCP client/sdk/server (required peers of `agents@0.27.0`), `@babel/core`, `@ai-sdk/provider`, `@types/react(-dom)`, `@axe-core/playwright`. `@cloudflare/voice` not installed. `.npmrc` sets `legacy-peer-deps=true` (npm 10.9 crashes resolving this tree), so peers must be listed by hand. | See docs/spikes.md |
| §14 unit tests in node | All tests run in workerd against `wrangler.mock.jsonc` | The `ai` binding forces a remote proxy session that needs credentials |
| §5.5 allocator | Learning has priority; reviews use at most half the day's slots while topics remain | A first version made roomy plans "overloaded" |
| §8.3 chat tools | Slim JSON schemas; `startStudyPlan` takes course, exam date, minutes and optional short topics (syllabus read from history, must look like a list); `createReminder` needs `when`; `remember` has no `fact`; tools offered by intent | Real-model findings above |
| not in plan | Rolling summary, `ai-binding.ts` workaround, `stripLeakedToolCalls`, server-side guards | Requested (summary) or found by real runs |
| §10 budgets | Estimator 3.0 chars/token; first-turn input about 380 tokens, average turn about 1,500 in / 70 out | Measured |
| §5.7 voice | 60 s cap by closing the socket (no `forceEndCall`); allowance and usage live in `StudyAgent` | SDK surface |
| §5.4 reminders | Cap of 100 applies to custom reminders only; the check-in is a `reminders` row; a reminder may be for the next minute (only the past is refused) | A 120-session plan; E2E speed |
| §15 deploy | `workers_dev: false` and `preview_urls: false` on the Worker; production `ALLOWED_ORIGINS` is the Pages origin only (local dev sets it in `.dev.vars`) | The API should be reachable only through Pages; localhost must not be an allowed origin in production |
| §11 CSP | As planned, plus `X-Frame-Options: DENY` and `form-action 'self'` | Defence in depth; verified with Mermaid and WebSockets under the CSP |

## Gotchas

- Extend `agents/tsconfig` and never set `experimentalDecorators`. The Vitest config needs the `agents/vite` plugin; the web app does not.
- `apps/api` `typecheck` runs `wrangler types` first (the generated `worker-configuration.d.ts` is gitignored); CI failed without it.
- `ensureSession()` is single-flight on purpose: two concurrent first `/api/session` calls (StrictMode double effects in dev, or two tabs opened at once) mint two different anonymous students and the browser keeps the last cookie, which looks like lost data. An E2E test that is flaky under `--repeat-each=24 --workers=4` found it; a plain WebSocket client could not reproduce it.
- Keep the `Suspense` boundary **below** `useAgent` (above it, React runs the connection hook's cleanup and the screen goes blank).
- The SDK handles chat-clear before `onMessage`; hook `resetTurnState()` for per-chat state.
- `destroy()` aborts the Durable Object; the Worker ignores that error, and `deleteAllData()` first waits for any in-flight chat turn.
- Agent state broadcasts to every client: keep it small and server-written.
- Headless Chromium (CI) differs from desktop Chrome: no notification permission, so the Today panel has no focusable button; the side panel is `tabIndex=0` for that reason. Always run Playwright in CI form (`npx playwright install chromium`) before trusting a local pass.
- axe samples colours mid-transition: the scan waits for `document.getAnimations()`.
- The mock model cannot catch provider, streaming-format or model-behaviour bugs. Treat `evals/run.mjs` and `smoke.mjs` as the real gate for anything that touches prompts, tools or the AI layer.
- `wrangler dev` with a real `ai` binding, and `wrangler deploy`, need a workers.dev subdomain on the account (one-time dashboard visit).
- The web bundle is about 1 MB (320 KB gzip) before Mermaid (lazy). Lazy-loading Streamdown is the easy win.
- `npm audit` reports advisories in dev-only `sharp` (via miniflare) and `katex` (via Mermaid); Mermaid runs with `securityLevel: "strict"` on text generated by our code.

## Maintaining README

After each milestone or session:

1. Add a phase entry (session id + UTC start) to `docs/dev-phases.json`.
2. Run `python3 scripts/sync_readme_log.py --stage "<what was just completed>"`. This regenerates the stage line, the dev-usage table and the verbatim conversation appendix, with secrets redacted.
3. Update "Application runtime usage" only from real `llm_usage` data (`evals/run.mjs --write` produces it).

If transcripts are not available (another tool, or a different machine), record figures as "unavailable".

## Commands

```bash
npm ci
npm run dev:mock -w apps/api   # Worker :8787 with the mock model (no login)
npm run dev -w apps/web        # Vite :5173, proxies /agents (ws) and /api
npm test                       # 132 tests in workerd
npm run check                  # oxlint, oxfmt --check, tsc (api after wrangler types, web)
PW_CHANNEL=chrome npm run e2e  # 19 Playwright tests (E2E + axe)
node apps/api/evals/run.mjs https://studyflow-1ir.pages.dev --write   # real-model evals
node apps/api/evals/smoke.mjs https://studyflow-1ir.pages.dev         # deployed smoke test
```

## Coding guidance (Ponytail principles, unchanged)

1. Before editing, list everything the change must reach (callers, tests, fixtures, config, exports) and what it could break or expose. That list is the scope.
2. Pick the first option that fully works: skip what nobody asked for → reuse the repo → use the platform (Agents SDK, Web APIs, `Intl`) → use an installed dependency → write one readable line → only then write the minimum new code.
3. No speculative abstractions, options or wrappers. Never cut validation, security, data-loss handling or accessibility.
4. Non-trivial logic ships with a small test. A deliberate shortcut gets a `// ponytail: <limit>, upgrade when <condition>` comment.
5. Finish with a note of what you skipped or did not verify.
