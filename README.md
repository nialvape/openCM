# openCM

Harness for a Community Manager agent for software products and projects, open source or private. It follows a GitHub repo, writes patch notes and X posts about what changed, asks the maintainer for approval on Telegram and learns from the answers.

It works on any repo the configured GitHub token can read, so a private product is as valid as a public project.

## How it works

1. Polls the repo for merged PRs and releases.
2. An analyst writes a change brief backed by the diff.
3. A writer drafts patch notes and posts; deterministic checks and a critic review them.
4. The maintainer approves, edits or rejects each draft on Telegram.
5. Approved posts are published to X, and the answers feed back into the agent as examples and lessons.

Everything particular to a tracked repo (language, voice, skills, examples) lives in `projects/<id>/`, which is gitignored. Start from `projects/_template/`.

## Usage

```bash
npm install
npm run dev -- doctor <project>
npm run dev -- bot <project>
```

Needs Node ≥ 22.13 and the keys in `.env` (see `.env.example`). Publishing is a dry run unless `DRY_RUN=0`.

Design, research basis and build phases: [docs/plan.md](docs/plan.md). Code map and rules: [AGENTS.md](AGENTS.md).
