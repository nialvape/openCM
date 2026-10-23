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
  cli.ts              entry point (opencm bot | doctor | ask | resume)
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
  sources/github/     thin GitHub REST client (fetch), only the fields openCM reads
  tools/repo.ts       read-only repo tools for agents (repo_list, repo_read_file, repo_search, list_prs, get_pr)
  channels/telegram/  bot.ts: grammY long polling, owner-only; chat.ts: one owner message → one chat run
  store/db.ts         SQLite (node:sqlite) in data/opencm.sqlite
data/                 GITIGNORED: database, traces, clones, outputs
```

## Rules

- **Model-agnostic.** Never import a provider outside `core/models.ts`. Roles name models as `<provider>:<model>` in config.
- **Policy is code.** A role only gets the tools its config lists; budgets come from config. Don't write "never do X" in a prompt when code can prevent X.
- **No agent publishes.** Publishing and memory writes are plain code triggered by an owner approval, never a tool.
- **Stable prompt prefix.** Anything that changes per task goes in the user message (`task`), not in a prompt section.
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
