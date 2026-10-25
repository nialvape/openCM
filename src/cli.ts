#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./core/paths.js";
import { ConfigError, loadHarnessConfig, loadProjectConfig, roleConfig } from "./core/config.js";
import { assemblePrompt, loadSections } from "./core/context.js";
import { loadDecisionSchema, thresholdFor } from "./core/decision.js";
import { runAgent } from "./core/loop.js";
import { startBot } from "./channels/telegram/bot.js";
import { modelFamily } from "./core/models.js";
import { discoverSkills, skillsIndex } from "./core/skills.js";
import { pipelineDeps } from "./pipeline/deps.js";
import { analyzeEvent, pendingEvents, poll, type StepResult } from "./pipeline/watch.js";
import { getPullRequest } from "./sources/github/changes.js";
import { addEvent, getEventByPr } from "./store/events.js";

const USAGE = `opencm — Community Manager agent harness

Usage:
  opencm bot <project>                    Start the Telegram bot (long polling, owner only)
  opencm run <project>                    Check GitHub once for newly merged PRs and process them
  opencm pr <project> <number>            Process one merged PR now, even an old one
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
  const project = loadProjectConfig(projectId);
  await startBot(project, loadHarnessConfig(project));
  return 0;
}

function report(r: StepResult): void {
  if (r.status === "briefed") {
    console.log(`PR #${r.pr}: briefed — ${r.brief.summary}`);
    if (r.patchNotes) console.log(`  patch notes ${r.patchNotes.version}: ${r.patchNotes.path}`);
  } else {
    console.log(`PR #${r.pr}: ${r.status} — ${r.reason}`);
  }
}

async function runOnce(projectId: string): Promise<number> {
  const deps = pipelineDeps(projectId);
  const added = await poll(deps);
  console.log(`${added.length} newly merged PR(s) since the last check`);
  for (const event of pendingEvents(deps)) report(await analyzeEvent(event, deps));
  return 0;
}

async function processPr(projectId: string, number: number): Promise<number> {
  if (!Number.isInteger(number) || number <= 0) throw new ConfigError("<number> must be a PR number, e.g. 16");
  const deps = pipelineDeps(projectId);
  const { pr } = await getPullRequest(deps.gh, number);
  if (!pr.merged_at) throw new ConfigError(`PR #${number} is not merged`);
  addEvent(deps.db, { project: projectId, pr: number, title: pr.title, url: pr.html_url, mergedAt: pr.merged_at });
  const result = await analyzeEvent(getEventByPr(deps.db, projectId, number)!, deps);
  report(result);
  return result.status === "failed" ? 1 : 0;
}

function doctor(projectId: string): number {
  const project = loadProjectConfig(projectId);
  const harness = loadHarnessConfig(project);
  const skills = discoverSkills(projectId);
  console.log(`project ${project.id}: ${project.repo}@${project.branch}, language ${project.language}`);
  console.log(`skills: ${skills.size ? [...skills.values()].map((s) => `${s.name} (${s.source})`).join(", ") : "none"}`);
  for (const role of Object.keys(harness.roles)) {
    const rc = roleConfig(harness, role);
    const sections = { ...loadSections(role, projectId), skills: rc.tools.includes("load_skill") ? skillsIndex(skills) : undefined };
    const prompt = assemblePrompt(sections, rc);
    const names = prompt.sections.map((s) => s.name).join(", ") || "none";
    console.log(`role ${role}: ${rc.model}, harness ${prompt.harnessVersion}, sections [${names}], tools [${rc.tools.join(", ")}]`);
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
