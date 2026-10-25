# openCM

Harness for a Community Manager agent for open-source projects. It follows a repo, writes patch notes and X posts about what changed, asks the maintainer for approval on Telegram and learns from the answers. The design, its research basis and the build phases are in `docs/plan.md`; this file is the map.

## Layout

```
config/default.yaml   models, tool allowlists and budgets per role — behavior lives here, not in prompts
prompts/<role>.md     base system prompt of each role
decisions/<name>.yaml decision schemas: typed questions answered by a decision model (projects can replace one)
skills/<name>/SKILL.md  generic skills (frontmatter: name, description); loaded on demand with load_skill
projects/_template/   committed example of a project folder
projects/<id>/        GITIGNORED: everything particular to a tracked repo (language, voice, skills, examples)
src/
  cli.ts              entry point (opencm bot | run | pr | eval | doctor | ask | resume)
  core/
    config.ts         loads config/default.yaml + the project's `harness:` override, validated with zod
    models.ts         "<provider>:<model>" → AI SDK model (OpenRouter by default); cost reported by OpenRouter or from config pricing
    context.ts        system prompt from ordered, named, hashed sections; the hash is the harness version
    skills.ts         discovers core + project skills (project wins on name clash), renders the index
    policy.ts         tool allowlist per role, secret scrubbing, output limits, fencing of untrusted text
    loop.ts           the agent loop: one generateText call per step, checkpoint after every step
    decision.ts       decision model call (OpenRouter Decisions API) + confidence gate; low-confidence answers go to the owner
    compact.ts        chat session compaction: split at a user turn, summary rides in the first kept turn
    trace.ts          JSONL trace per run in data/traces/
    structured.ts     runAgentJson: final answer must be JSON matching a zod schema, one corrective retry
  sources/github/     client.ts: thin GitHub REST client; changes.ts: merged-PR polling, diff elision,
                      prefilter (no model), version-bump detection
  tools/repo.ts       read-only repo tools for agents (repo_list, repo_read_file, repo_diff, repo_search, list_prs, get_pr)
  tools/measure.ts    measure_posts: X's exact weighted length per post; the only way agents get a character count
  pipeline/           watch.ts: poll → prefilter → brief (analyst) → patch notes on a release
                      brief.ts: ChangeBrief schema (each change with file evidence); patch-notes.ts
                      decide.ts: format via the decision model + guards (release → thread, daily cap → hold)
                      draft.ts: writer → checks → critic, ≤2 rewrites; flow.ts: advance() one event, digest
  checks/checks.ts    deterministic checks on drafts: weighted length, link policy, claims vs brief, banned terms, secrets
  evals/run.ts        eval runner: core cases (evals/cases, e.g. prompt injection) + project cases; reports in data/
  channels/telegram/  bot.ts: grammY long polling, owner-only, watch loop every watch.pollMinutes;
                      cards.ts: draft cards and format questions with buttons; chat.ts: one owner message → one chat run
  channels/x/         oauth1.ts: OAuth 1.0a signing; client.ts: create post, read public metrics
  pipeline/publish.ts publishes an approved draft as a reply chain (dry run unless DRY_RUN=0), daily spend cap,
                      resumable; collects engagement at x.metricsAfterHours
  pipeline/memory.ts  approved posts become writer examples; each draft records the examples it used, and
                      approvals, edits, rejections and engagement credit them; lowest-scored evicted
  pipeline/reflect.ts reflect role proposes lessons from the owner's corrections, reviewer (other family)
                      filters them, the owner accepts; code appends accepted ones to projects/<id>/lessons.md
  pipeline/review.ts  what the owner's buttons do: approve, reject, edit (verbatim or instruction), change format;
                      every choice is stored as a label for the decision model
  store/db.ts         SQLite (node:sqlite) in data/opencm.sqlite; events.ts: merged PRs and their status
data/                 GITIGNORED: database, traces, clones, outputs
```

## Rules

- **Model-agnostic.** Never import a provider outside `core/models.ts`. Roles name models as `<provider>:<model>` in config.
- **Policy is code.** A role only gets the tools its config lists; budgets come from config. Don't write "never do X" in a prompt when code can prevent X.
- **No agent publishes.** Publishing and memory writes are plain code triggered by an owner approval, never a tool.
- **Stable prompt prefix.** Anything that changes per task goes in the user message (`task`), not in a prompt section.
- **Models never count.** Lengths come from code (`measure_posts`, `runChecks`), never from a model's estimate. Fix a failing post on its own before rewriting a whole draft.
- **Untrusted text is fenced.** PR bodies, commits and issues reach the model through `asUntrustedData`.
- **Project-specific content never goes in the core.** If it's about one repo, it belongs in `projects/<id>/`.
- **Every harness change is measured.** Prompt, skill and config changes change the harness version; run the evals before relying on a new version (from phase 3).

## Conventions

- TypeScript ESM, `module: Node16`, imports with `.js` extension. Node ≥ 22.13 (for `node:sqlite`).
- Identifiers, comments and logs in English. Content for a project is written in that project's `language`.
- Errors say what to do next. Own errors are classes with a `name` (`ConfigError`, `PolicyError`, `SkillError`).
- Comments explain the why in one or two lines.

## Verify

- `npm run typecheck` and `npm test` (vitest; uses a mock model, no API keys needed).
- `npm run dev -- doctor <project>` validates a project's config and shows each role's harness version.
- `npm run dev -- ask <project> writer "<task>"` runs a real model (needs the provider key in `.env`).
- `npm run dev -- bot <project>` starts the Telegram bot (needs TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID).
