#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./core/paths.js";
import { ConfigError, loadHarnessConfig, loadProjectConfig, roleConfig } from "./core/config.js";
import { assemblePrompt, loadSections } from "./core/context.js";
import { loadDecisionSchema, thresholdFor } from "./core/decision.js";
import { runAgent } from "./core/loop.js";
import { modelFamily } from "./core/models.js";
import { discoverSkills, skillsIndex } from "./core/skills.js";

const USAGE = `opencm — Community Manager agent harness

Usage:
  opencm doctor <project>                 Validate config, list skills and the harness version of each role
  opencm ask <project> <role> "<task>"    Run one role on a free-form task (smoke test)
  opencm resume <project> <role> <runId>  Resume an interrupted run from its last checkpoint
`;

async function main(argv: string[]): Promise<number> {
  const envFile = join(paths.root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const [command, ...args] = argv;
  switch (command) {
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
