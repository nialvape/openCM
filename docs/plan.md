# openCM — harness for an open-source Community Manager agent

## Context

`D:\proyectos\openCM` is empty. Goal: an agent that follows an open-source repo, writes patch notes and social content explaining the changes, publishes to X, and talks with the maintainer over Telegram. First project: `nialvape/utn-mcp` (TS MCP server, PR-per-change workflow, no tags, version bumped in `package.json` + `src/server.ts`). The user's thesis: **the harness matters more than the model** — so quality must come from structure (context, verification, feedback), and models must be swappable and measurable.

Decisions taken: own loop on **Vercel AI SDK** (model-agnostic), **every post approved in Telegram**, **runs on the user's PC** for now, and **everything project-specific (language, voice, audience…) lives in a gitignored per-project folder**.

## Research basis (only sources from 22 Apr 2026 – 22 Oct 2026)

Older material (2025 posts, early-2026 lab blogs, NeurIPS 2024) was dropped on purpose. Most findings are arXiv preprints — recent but mostly not peer-reviewed; only abstracts were read, so numbers are quoted from abstracts.

| Finding | Source (date) | Design consequence |
|---|---|---|
| With the model held fixed, harness changes alone shifted agent effectiveness and efficiency across 35 releases; regressions blamed on the model often came from harness changes | Ben Sghaier, Li, Adams, Hassan — arXiv 2607.03691 (Jul 2026) | Confirms the thesis. **Every prompt/skill/config change is versioned and must pass the eval suite before it's used** (regression gate) |
| Source-code study of 11 production harnesses: none imports a general-purpose agent framework; hand-rolled async loops and deterministic retrieval, no vector embeddings; SKILL.md skills are the most adopted extension (9/11, ahead of MCP); behavioral policy is moving from prompt prose into configuration | Barbaste et al. — arXiv 2609.00006 (Jul 2026) | Own small loop; AI SDK used as the provider layer, not as the framework. Retrieval is deterministic (git diff, PR API, file paths, grep) — no vector DB. Skills as `SKILL.md`. Tool allowlists, budgets and limits live in config, not in prompts |
| Rule-based elision before LLM summarization is the most efficient context strategy; making elided content recoverable added complexity without accuracy. Planning helps weaker models' accuracy and mainly cuts cost on strong ones. Predefined tools help models weak at bash | Fan et al. — arXiv 2609.20804 (Sep 2026) | Diffs trimmed by rules first (lockfiles, vendored, generated, whitespace) and only then summarized. No "recoverable compression" machinery. Optional plan step per model in config. Predefined read-only repo tools instead of a shell (also safer) |
| Harnesses that store per-case diagnoses plus distilled global patterns and retrieve them per task beat fixed harnesses | Huang et al., MemoHarness — arXiv 2607.14159 (Jul 2026) | Two-level memory: per-draft diagnosis records + distilled `lessons.md`; retrieve relevant ones per task |
| For content-generation agents, memory evolved from **delayed engagement feedback**, with credit assigned to the memories used in each generation (reinforce / mutate / evict under a capacity cap), improved CTR in an online A/B test | Mao et al., TIDE — arXiv 2609.37544 (Sep 2026) | Each draft records which examples/lessons were in context. When X metrics arrive (24h, 7d), those items get credit; low-value examples are evicted under a size cap. Measured against a no-memory baseline |
| In-band judges, even the strongest, accepted real regressions 44% of the time; self-verdict gates degenerate into accept-all; grounding the gate in external outcomes is what helps | Park & Choi — arXiv 2607.25152 (Jul 2026) | The critic is advisory. The gate is the human approval; long-term quality is measured by approval rate, edit distance and engagement — not critic scores |
| Every model family studied favored its own family's outputs by 3.4–8.4 pp; 55% of AB/BA pairs flipped with order; panel composition changed 18.5% of outcomes | Awuni et al. — arXiv 2609.17857 (Sep 2026) | Critic from a different model family than the writer. Score single drafts on an absolute rubric (no pairwise); when comparing in evals, run both orders |
| Harness-level security controls (tool restriction, OS sandboxing, skill scanning) give consistent results where relying on model behavior doesn't; tested with a suite derived from the OWASP Top 10 for Agentic Applications | Gore — arXiv 2607.25890 (Jul 2026) | Restrictions enforced in code per role. Only local, reviewed skills load. Security eval cases (e.g. a PR body containing injected instructions) |
| Skill harnessing reference architecture: supply chain → mediation → execution control → evidence & feedback; run evidence enables attribution and repair | Xia et al. — arXiv 2606.20631 (May 2026) | Skills have provenance (core vs project), are selected per run, and each run logs which skills were loaded — feeds the TIDE-style credit assignment |
| The harness owns conversation state, approvals and compaction; compaction plus retained reasoning gave large gains on long tasks | OpenAI, "Codex as a platform" (developers.openai.com, ~Jul 2026; page shows no date) | Pipeline runs are short, so no compaction there. The long-lived Telegram chat session does get compaction |
| Clean-context reviewers and read-only helper agents work; parallel writers and free-form swarms don't yet | Cognition, "Multi-Agents: What's Actually Working" (22 Apr 2026 — right at the cutoff) | One writer; critic reviews from a fresh context; analyst is read-only. Borderline-age source, so it supports the design rather than driving it |
| Turn/step loop with a checkpoint after every step; chat transcript, model conversation and memory stored apart; prompt from named, hashed sections with changes appended as notes; memory changes proposed with citations, reviewed by a second model, applied by code; skills saved only after a workflow worked | SpaceXAI Grok Bot (Aug 2026), from a reverse-engineering gist and reviews (no official docs) | Mechanisms 5 and 10 below; propose a project skill when a post pattern keeps getting approved |

Platform facts (checked against current primary docs):
- **X API** (docs.x.com pricing page): create post **$0.015**, post with a URL **$0.200**, read **$0.005 per post**; a per-cycle spending limit blocks requests when reached. Default: links go in a reply or are left out (configurable per project).
- **AI SDK** (ai-sdk.dev, current docs): `ToolLoopAgent` with `stopWhen`, `prepareStep`, `runtimeContext`, `toolsContext`; also a `HarnessAgent` that runs Claude Code / Codex / Pi as a harness. We use the provider layer and `prepareStep`-style control, keeping the loop ours.

## Architecture

```
GitHub poller ─▶ events (SQLite) ─▶ pre-filter ─▶ analyst ─▶ change-brief.md
   (deterministic)                 (rules)       (read-only repo tools)   │
                                                                          ▼
                        decision model (probabilities) + confidence gate: skip | hold | post | thread
                                            (below threshold → you choose in Telegram)
                                                                          │ (post / thread / digest due)
                          patch-notes.md ◀── writer (format-specific skill) ◀┘  (memory items used are recorded)
                          x drafts       ◀──   │  ▲ revise (≤2)
                                               ▼  │
                            deterministic checks → critic (other model family, fresh context)
                                               │
                                     Telegram approval (Approve / Edit / Reject)
                                               │ approved
                                     X publisher (plain code, dry-run by default)
                                               │
                     metrics @24h/7d ─▶ credit to memory items used ─▶ reinforce / evict
                     decisions + edits ─▶ diagnoses ─▶ distilled lessons (owner approves)
Telegram chat ─▶ chat agent (read-only tools, compacted session)
```

Units of change: each merged PR triggers the pipeline. A **version bump** (`package.json` version change on main) or a release/tag always produces patch notes for everything since the previous bump.

### Content decision (how big should the content be?)

Not every merged PR deserves a post. The format is chosen by a **decision model**: the new category launched in Oct 2026 (TypeSafe AI's Jev, Cloudflare's open-weight Clef 27B / Clef-Flash 9B, OpenAI's Decisions API, and offerings from Perplexity, AWS and Fastino). A decision model doesn't generate text. It takes a state plus a schema of typed questions, each with allowed options, and returns a probability for every option in one forward pass. The LLM writes; the decision model decides; code enforces the limits.

1. **Pre-filter (rules, no model)** runs before the analyst. PRs that only touch CI, tests, lockfiles, formatting or dependencies are logged as `skip` at no cost. Paths and labels to ignore live in `project.yaml`.
2. **Decision model call** on a state built from the change brief, PR facts (files, size, labels, new tools, version bump), the held queue and recent posting history. The decision schema is per project and generic by default:
   - `format`: `skip` (internal; still goes into the next patch notes) · `hold` (small but real; goes to the digest queue) · `post` (one tweet) · `thread` (new feature/tool, breaking change, several related changes, version bump)
   - `merge_with_held`: yes / no
   - `link_worth_cost`: yes / no (a post with a URL costs $0.20 vs $0.015)
3. **Confidence gating.** Each question has a threshold, fitted on labeled history (the JevAgentHarness paper reports that delegating decisions *without* fitted thresholds cut task success by 19 points). Above the threshold, the decision is used. Below it, the Telegram card asks you to pick the format, with the model's probabilities shown. No LLM fallback is needed, because every post already passes through you.
4. **Fixed rules wrap the decision.** A cap on posts per day (extra items become `hold`). A version bump always produces patch notes. `/digest` publishes the held queue now.
5. **Learning.** Every choice you make or override is a labeled example. These are used to refit the thresholds, as eval cases (utn-mcp PRs #1–#16 labeled with your choice), and later, once there's enough data, to fine-tune or adapt the decision model (Clef plans fine-tuning from labeled history).
6. **Provider-agnostic.** Built on AI SDK v7's `experimental_decide`. The default route is OpenRouter's Decisions API (`openrouter:cloudflare/clef-flash`; it also serves `cloudflare/clef`, `typesafe/jev-1.14`, Perplexity deciders and others), so one key covers LLMs and decision models. The model is chosen in config, like the LLM roles.

Caveats: every benchmark in this category is published by its own vendor, and the products are weeks old. That's why the eval suite measures the decision model on our own labeled cases before it's trusted, and why the thresholds come from our data rather than the vendor's.

## Layout

```
openCM/
  AGENTS.md                  short map of the repo for coding agents
  .env.example               model keys, GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID, X_* keys
  config/default.yaml        roles → model, tool allowlist, step/token/$ budgets, plan step on/off
  src/
    core/
      loop.ts                own async loop over AI SDK: step budget, per-step context assembly,
                             hook points (beforeTool/afterTool/onFinish), tracing, cost metering
      models.ts              role → provider/model registry from config (per-project override)
      decision.ts            DecisionProvider interface + adapters (Workers AI Clef/Jev-compatible,
                             OpenAI Decisions API), per-question thresholds, threshold fitting
      context.ts             fixed prefix (role prompt → project profile → skills index) + task data last;
                             rule-based elision, then summarize only if still over budget
      skills.ts              discover SKILL.md (core + project), index, load_skill, log usage per run
      memory.ts              examples/lessons/diagnoses store with usage log, credit scores, capacity cap
      policy.ts              enforce config: tool allowlist per role, output-size limits, secret scrubbing
      trace.ts               JSONL trace per run (steps, tool calls, tokens, $, harness version)
    sources/github/          poller (octokit), PR/commit/diff fetch, local clone, version-bump detection
    pipeline/                prefilter, analyze, decide, digest, write, check, critique, gate, publish,
                             metrics, reflect
    checks/                  X weighted length (twitter-text), link policy, banned/required terms,
                             claim-has-evidence, no secrets/tokenized URLs
    channels/
      telegram/              grammY bot: owner-only, approval cards, /status /drafts /run, chat
      x/                     publisher (OAuth 1.0a user context), DRY_RUN default, spend cap, metrics fetch
    tools/                   repo_read_file, repo_list, repo_diff (paged), repo_search, get_pr,
                             list_events, read_brief, memory_read, load_skill
    store/                   SQLite: events, runs, drafts, decisions, posts, metrics, memory_usage
    cli.ts                   opencm run <project> | opencm bot | opencm eval <project> [--model role=x]
  prompts/                   analyst.md writer.md critic.md chat.md reflect.md
  decisions/                 generic decision schemas (content-format.yaml); projects can override
  skills/                    generic: explain-change/ patch-notes/ x-post/ x-thread/ x-digest/ critique-post/
  evals/                     runner, scorers, security cases (prompt injection in PR text, secret leaks)
  projects/
    _template/               committed example
    utn-mcp/                 GITIGNORED: project.yaml (repo, language, cadence, link policy, model
                             overrides), profile.md audience.md voice.md glossary.md, skills/,
                             examples/, lessons.md, evals/cases/
  data/                      GITIGNORED: sqlite, clones, traces, briefs, outputs, eval reports
```

A project skill with the same name overrides the generic one.

## Key harness mechanisms

1. **Policy in config, enforced in code.** Each role's tools, budgets and model come from config; `policy.ts` blocks anything else. No role has a publish or memory-write tool.
2. **Deterministic retrieval and grounding.** The analyst reads diffs/PRs via fixed tools. The brief lists each user-facing change with evidence (PR #, file). The writer may claim only what's in the brief; a check fails claims without a reference.
3. **Critic.** Different model family, fresh context (brief + draft + rubric only), absolute 1–5 rubric (accuracy, clarity, hook, voice, user value, no hype), JSON output with fixes. Runs after the deterministic checks. Advisory only.
4. **Human gate.** Telegram card: draft, critic scores, source PRs. Edit = new text or an instruction → writer revises. Every decision stored.
5. **Outcome-grounded memory.** Store which examples/lessons were used per draft. Approval/edit/reject plus X metrics at 24h/7d give each item credit. Low-value items are evicted under a cap. A `reflect` job turns per-case diagnoses into cited `lessons.md` proposals. A reviewer model from another family checks them, code applies them to a snapshot, and the owner approves in Telegram. Memory holds style and lessons only; facts always come from the repo.
6. **Regression gate for the harness.** Prompts, skills and config carry a harness version. `opencm eval` must not regress before a new version becomes active. Reports compare models and harness versions on score, approval proxy and cost.
7. **Security.** PR/issue text is wrapped as data. Only local skills load. Security eval cases run with every eval.
8. **Context.** Fixed cache-friendly prefix, task data last. Rule-based trimming before any LLM summarization. Compaction only in the long-lived chat session.
9. **Observability & cost.** JSONL traces with tokens and $ per role. `/status` shows spend. Budgets abort runs.
10. **Durable runs.** Turn/step loop with a checkpoint after every step (resume after a PC shutdown). The Telegram transcript, model conversations and memory are stored apart. Prompt sections are named and hashed, and the hash is the harness version used in traces and evals.

## Build phases

1. **Scaffold + core**: TS/Node 20+ ESM (utn-mcp conventions), config, loop, models, context, policy, trace, skills, SQLite, CLI, `AGENTS.md`, `.gitignore` for `projects/*` (except `_template`) and `data/`.
2. **Ingest + analyze**: poller, clone, version-bump detection, elision rules, analyst → `change-brief.md`, patch notes. `opencm run utn-mcp` writes files only.
3. **Decide + write + judge + evals**: pre-filter rules, decision provider + content-format schema + confidence gate + guards, labeled format cases, digest queue, x-post/x-thread/x-digest skills, checks, critic, revise loop, eval runner (quality + security cases) on utn-mcp history, harness versioning.
4. **Telegram**: owner-only bot, approval/edit flow, `/status /drafts /run`, chat agent with compaction.
5. **X publisher + metrics**: dry-run first, then real posts with spend cap; metrics fetch at 24h/7d.
6. **Memory evolution**: usage/credit, eviction cap, reflect → lessons proposals; measure against a no-memory baseline.

## Verification

- `npx tsc --noEmit` + `vitest` for deterministic parts (weighted length, link policy, elision rules, version-bump detection, skill override, policy enforcement, credit/eviction).
- Phase 2: run on real `nialvape/utn-mcp` history; check every brief claim for PRs #11–#16 against the diff.
- Phase 3: `opencm eval utn-mcp` with two writer models and two critic families; a prompt-injection PR fixture must never change the output's intent.
- Phase 4–5: end to end on the PC with `DRY_RUN=1` (PR → Telegram card → approve → publisher logs the payload). Then one real post after the owner confirms.

## Needed from the user before phases 4–5

Telegram bot token (BotFather) and owner user ID; X developer app on pay-per-use with OAuth 1.0a user tokens for the CM account and a spending limit set; a GitHub token (read-only is enough for a public repo).

## Sources (all dated 22 Apr 2026 or later)

- Ben Sghaier, Li, Adams, Hassan — Don't Blame the Large Language Model: How Agent Harness Evolution Shapes Coding Agent Quality (4 Jul 2026) — https://arxiv.org/abs/2607.03691
- Barbaste, Darrigol, Vu, Wiltberger — Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents (15 Jul 2026) — https://arxiv.org/abs/2609.00006
- Fan et al. — An Empirical Study of Harness Design for Coding Agents (17 Sep 2026) — https://arxiv.org/abs/2609.20804
- Huang et al. — MemoHarness: Agent Harnesses That Learn from Experience (14 Jul 2026) — https://arxiv.org/abs/2607.14159
- Mao et al. — TIDE: Trajectory-Informed Directed Memory Evolution (29 Sep 2026) — https://arxiv.org/abs/2609.37544
- Park & Choi — When Do Agent Loops Mistake Stagnation for Progress? (Jul 2026) — https://arxiv.org/abs/2607.25152
- Awuni et al. — Who Judges Matters: Measuring Family-Conditioned Preference in LLM-as-Judge Panels (15 Sep 2026) — https://arxiv.org/abs/2609.17857
- Gore — Distributing Security Controls Through Harness Engineering (28 Jul 2026) — https://arxiv.org/abs/2607.25890
- Xia et al. — Harnessing Agent Skills: Architectural Patterns and a Reference Architecture (29 May 2026) — https://arxiv.org/abs/2606.20631
- Grok Bot harness analysis (third-party gist) — https://gist.github.com/gfsaaser24/9f785c0c095b693b31b5efbcbae7bcd0 ; Flavio Copes, A deep dive into Grok Bot (updated 21 Oct 2026) — https://flaviocopes.com/grok-bot/
- Decision models: InfoQ, Cloudflare open sources decision models for AI agents (8 Oct 2026) — https://www.infoq.com/news/2026/10/clef-decision-models/ ; Forbes, A guide to the new wave of AI decision models (12 Oct 2026) — https://www.forbes.com/sites/ronschmelzer/2026/10/12/decisions-decisions-a-guide-to-the-new-wave-of-ai-decision-models-besides-jev/ ; Zhu et al., JevAgentHarness (15 Oct 2026) — https://arxiv.org/abs/2610.21412
- OpenAI — Codex as a platform (undated; references a 2026-07-07 changelog) — https://developers.openai.com/blog/codex-as-a-platform
- Cognition — Multi-Agents: What's Actually Working (22 Apr 2026, at the cutoff) — https://cognition.com/blog/multi-agents-working
- X API pricing (current docs) — https://docs.x.com/x-api/getting-started/pricing
- AI SDK agents docs (current) — https://ai-sdk.dev/docs/agents/overview
- utn-mcp repo and AGENTS.md — https://github.com/nialvape/utn-mcp
