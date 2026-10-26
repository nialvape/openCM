#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./core/paths.js";
import { ConfigError, loadHarnessConfig, loadProjectConfig, roleConfig } from "./core/config.js";
import { harnessVersions, roleContext } from "./core/context.js";
import { loadDecisionSchema, thresholdFor } from "./core/decision.js";
import { runAgent } from "./core/loop.js";
import { startBot } from "./channels/telegram/bot.js";
import { modelFamily } from "./core/models.js";
import { discoverSkills } from "./core/skills.js";
import { pipelineDeps } from "./pipeline/deps.js";
import { pendingEvents, poll } from "./pipeline/watch.js";
import { advance, draftPullRequest, maybeDigest, type Outcome } from "./pipeline/flow.js";
import { renderDraft } from "./pipeline/draft.js";
import { runEvals, withOverrides, type CaseResult } from "./evals/run.js";

const USAGE = `opencm — Community Manager agent harness

Usage:
  opencm bot <project>                    Start the Telegram bot (long polling, owner only)
  opencm run <project>                    Check GitHub once for newly merged PRs and process them
  opencm pr <project> <number>            Process one merged PR now, even an old one
  opencm eval <project> [--model role=id] [--no-memory] [--fresh-briefs] [--decisions-only] [--with-history]
                                          Run the eval cases and compare with the last report;
                                          --decisions-only stops at the format decision (no drafts);
                                          --with-history gives the other cases' labels as precedents
  opencm doctor <project>                 Validate config, list skills and the harness version of each role
  opencm ask <project> <role> "<task>"    Run one role on a free-form task (smoke test)
  opencm resume <project> <role> <runId>  Resume an interrupted run from its last checkpoint
`;

async function main(argv: string[]): Promise<number> {
  const envFile = join(paths.root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const [command, ...args] = argv;
  switch (command) {
    case "bot":
      return bot(required(args[0], "project"));
    case "run":
      return runOnce(required(args[0], "project"));
    case "pr":
      return processPr(required(args[0], "project"), Number(required(args[1], "number")));
    case "eval":
      return evals(required(args[0], "project"), args.slice(1));
    case "doctor":
      return doctor(required(args[0], "project"));
    case "ask":
      return ask(required(args[0], "project"), required(args[1], "role"), required(args[2], "task"));
    case "resume":
      return ask(required(args[0], "project"), required(args[1], "role"), "", required(args[2], "runId"));
    default:
      process.stdout.write(USAGE);
      return command ? 1 : 0;
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConfigError(`Missing <${name}>.\n\n${USAGE}`);
  return value;
}

async function bot(projectId: string): Promise<number> {
  await startBot(projectId);
  return 0;
}

function report(o: Outcome): void {
  switch (o.kind) {
    case "drafted": {
      const prs = o.events.map((e) => `#${e.pr}`).join(", ");
      const score = o.draft.score !== undefined ? `critic ${o.draft.score}/5` : "no critic score";
      console.log(`\n${prs}: ${o.draft.draft.format} drafted (${score}, ${o.draft.revisions} revisions, draft ${o.draft.id})`);
      for (const i of o.draft.issues) console.log(`  ! ${i.where}: ${i.message}`);
      console.log(renderDraft(o.draft.draft).replace(/^/gm, "  | "));
      if (o.patchNotes) console.log(`  patch notes ${o.patchNotes.version}: ${o.patchNotes.path}`);
      break;
    }
    case "ask_format": {
      const p = o.decision.probabilities;
      const probs = p ? Object.entries(p).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ") : "no probabilities";
      console.log(`\n#${o.event.pr}: needs your choice of format (${o.decision.reason}; ${probs})`);
      break;
    }
    default:
      console.log(`\n#${o.event.pr}: ${o.kind} — ${o.reason}`);
  }
}

async function runOnce(projectId: string): Promise<number> {
  const deps = pipelineDeps(projectId);
  const added = await poll(deps);
  console.log(`${added.length} newly merged PR(s) since the last check`);
  for (const event of pendingEvents(deps)) report(await advance(event, deps));
  const digest = await maybeDigest(deps);
  if (digest) report(digest);
  return 0;
}

function parseOverrides(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-memory" || args[i] === "--fresh-briefs" || args[i] === "--decisions-only" || args[i] === "--with-history") continue;
    if (args[i] !== "--model") throw new ConfigError(`Unknown option '${args[i]}'. Use --model <role>=<provider>:<model>`);
    const [role, ...rest] = (args[++i] ?? "").split("=");
    if (!role || !rest.length) throw new ConfigError("--model needs <role>=<provider>:<model>, e.g. writer=openrouter:openai/gpt-6-luna");
    out[role] = rest.join("=");
  }
  return out;
}

async function evals(projectId: string, args: string[]): Promise<number> {
  const project = loadProjectConfig(projectId);
  const harness = withOverrides(loadHarnessConfig(project), parseOverrides(args));
  const pct = (n?: number) => (n === undefined ? "n/a" : `${Math.round(n * 100)}%`);
  const memory = !args.includes("--no-memory");
  const decisionsOnly = args.includes("--decisions-only");
  const leanText = (c: CaseResult) => (c.lean ? `, leaned ${c.lean.format} ${Math.round(c.lean.probability * 100)}%${c.lean.correct === false ? " ✗" : ""}` : "");
  const { report: r, previous, file } = await runEvals(project, harness, (c) => {
    const bits = [
      c.briefCached ? "cached brief" : "",
      !c.format && c.formatSource === "unsure" ? `model unsure${leanText(c)}${c.expectedFormat ? ` (expected ${c.expectedFormat})` : ""}` : "",
      c.format ? `${c.format}${c.expectedFormat ? (c.formatCorrect === undefined ? ` (expected ${c.expectedFormat}, model unsure${leanText(c)})` : c.formatCorrect ? " ✓" : ` ✗ expected ${c.expectedFormat}`) : ""}` : "",
      c.checksPassed === undefined ? "" : c.checksPassed ? "checks ok" : `${c.checkIssues.length} check issues`,
      c.criticScore !== undefined ? `critic ${c.criticScore}` : "",
      c.mentionMissing.length ? `missing: ${c.mentionMissing.join(", ")}` : "",
      c.avoidFound.length ? `FORBIDDEN: ${c.avoidFound.join(", ")}` : "",
      c.error ? `error: ${c.error}` : "",
      `$${c.costUsd.toFixed(4)}`,
    ].filter(Boolean);
    console.log(`${c.name} (#${c.pr}): ${bits.join(" · ")}`);
    for (const issue of c.checkIssues) console.log(`    ! ${issue}`);
  }, { memory, freshBriefs: args.includes("--fresh-briefs"), decisionsOnly, withHistory: args.includes("--with-history") });
  const s = r.summary;
  const line = (label: string, now: string, before?: string) => console.log(`  ${label.padEnd(16)} ${now}${before !== undefined && before !== now ? `  (before: ${before})` : ""}`);
  const ps = previous?.summary;
  console.log(`\nSummary (${r.cases.length} cases${memory ? "" : ", no memory: baseline"}${decisionsOnly ? ", decisions only" : ""}${args.includes("--with-history") ? ", with precedents" : ""})`);
  line("format accuracy", pct(s.formatAccuracy), ps && pct(ps.formatAccuracy));
  line("model unsure", pct(s.unsureRate), ps && pct(ps.unsureRate));
  line("lean when unsure", pct(s.leanAccuracy), ps && pct(ps.leanAccuracy));
  line("checks passed", pct(s.checkPassRate), ps && pct(ps.checkPassRate));
  line("critic score", `${s.meanCriticScore ?? "n/a"}`, ps && `${ps.meanCriticScore ?? "n/a"}`);
  line("mentions", pct(s.mentionRate), ps && pct(ps.mentionRate));
  line("forbidden text", `${s.avoidViolations}`, ps && `${ps.avoidViolations}`);
  line("failures", `${s.failures}`, ps && `${ps.failures}`);
  line("cost", `$${s.costUsd}`, ps && `$${ps.costUsd}`);
  if (previous) {
    const changed = Object.keys(r.harness).filter((role) => previous.harness[role] !== r.harness[role]);
    console.log(changed.length ? `\nHarness changed since the last eval for: ${changed.join(", ")}` : "\nSame prompts, skills and config as the last eval.");
    const code = (c?: { commit: string; dirty: boolean }) => (c ? `${c.commit}${c.dirty ? " + uncommitted changes" : ""}` : "unknown");
    if (code(previous.code) !== code(r.code)) console.log(`Code: ${code(previous.code)} → ${code(r.code)}`);
  }
  console.log(`Report: ${file}`);
  return s.avoidViolations > 0 || s.failures > 0 ? 1 : 0;
}

async function processPr(projectId: string, number: number): Promise<number> {
  if (!Number.isInteger(number) || number <= 0) throw new ConfigError("<number> must be a PR number, e.g. 16");
  // From the CLI a PR is re-briefed: it's how you check a changed analyst on a real PR.
  const outcome = await draftPullRequest(number, pipelineDeps(projectId), { rebrief: true });
  report(outcome);
  return outcome.kind === "failed" ? 1 : 0;
}

function doctor(projectId: string): number {
  const project = loadProjectConfig(projectId);
  const harness = loadHarnessConfig(project);
  const skills = discoverSkills(projectId);
  console.log(`project ${project.id}: ${project.repo}@${project.branch}, language ${project.language}`);
  console.log(`skills: ${skills.size ? [...skills.values()].map((s) => `${s.name} (${s.source})`).join(", ") : "none"}`);
  const versions = harnessVersions(projectId, harness);
  for (const role of Object.keys(harness.roles)) {
    const rc = roleConfig(harness, role);
    const { prompt, skills: loadable } = roleContext(role, projectId, rc, skills);
    const names = prompt.sections.map((s) => s.name).join(", ") || "none";
    const skillNames = loadable.size ? `, skills [${[...loadable.keys()].join(", ")}]` : "";
    console.log(`role ${role}: ${rc.model}, harness ${versions[role]}, sections [${names}], tools [${rc.tools.join(", ")}]${skillNames}`);
  }
  const formatSchema = loadDecisionSchema("content-format", projectId);
  const questions = Object.keys(formatSchema.questions)
    .map((q) => `${q}≥${thresholdFor(harness.decisions, formatSchema.name, q)}`)
    .join(", ");
  console.log(`decisions: ${harness.decisions.model}, content-format v${formatSchema.version} (${formatSchema.source}) [${questions}]`);
  const writer = harness.roles.writer;
  const critic = harness.roles.critic;
  if (writer && critic && modelFamily(writer.model) === modelFamily(critic.model)) {
    console.log(`warning: writer and critic are both ${modelFamily(writer.model)} models; judges favor their own family's output`);
  }
  return 0;
}

async function ask(projectId: string, role: string, task: string, resumeRunId?: string): Promise<number> {
  const project = loadProjectConfig(projectId);
  const harness = loadHarnessConfig(project);
  const result = await runAgent({ role, projectId, task, harness, resumeRunId });
  console.log(result.text || "(no text)");
  console.error(`\nrun ${result.runId}: ${result.status}, ${result.steps} steps, cost ${result.costUsd?.toFixed(4) ?? "unknown"} USD, harness ${result.harnessVersion}`);
  return result.status === "done" ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
    process.exit(1);
  },
);
