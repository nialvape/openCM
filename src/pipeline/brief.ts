import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { asUntrustedData } from "../core/policy.js";
import { paths } from "../core/paths.js";
import { runAgentJson } from "../core/structured.js";
import { elideFiles } from "../sources/github/changes.js";
import type { PullRequest, PullRequestFile } from "../sources/github/client.js";
import type { PipelineDeps } from "./types.js";

export const ChangeSchema = z.object({
  id: z.string().regex(/^c\d+$/, "ids are c1, c2, …"),
  kind: z.enum(["feature", "fix", "improvement", "breaking", "internal", "docs"]),
  what: z.string().min(1),
  userImpact: z.string(),
  evidence: z.array(z.string().min(1)).min(1, "every change needs at least one file as evidence"),
});

export const ChangeBriefSchema = z.object({
  pr: z.number().int(),
  title: z.string(),
  summary: z.string().min(1),
  userFacing: z.boolean(),
  changes: z.array(ChangeSchema).min(1),
  breaking: z.boolean(),
  upgradeSteps: z.array(z.string()).default([]),
});

export type ChangeBrief = z.infer<typeof ChangeBriefSchema>;

/** Facts the analyst gets up front; it reads the diff itself with repo_diff. */
function briefTask(pr: PullRequest, files: PullRequestFile[], deps: PipelineDeps, version?: string): string {
  const fileLines = elideFiles(files, deps.project.prefilter.ignorePaths).map(
    (f) => `- ${f.status} ${f.file} (+${f.additions} −${f.deletions})${f.elided ? ` [${f.elided}]` : ""}`,
  );
  return [
    `Write the change brief for PR #${pr.number} of ${deps.project.repo}, merged ${pr.merged_at?.slice(0, 10)}.`,
    version ? `This PR releases version ${version}.` : "",
    `Write the text fields in ${deps.project.language}.`,
    "",
    "Changed files:",
    ...fileLines,
    "",
    asUntrustedData(`PR #${pr.number} title and description`, `${pr.title}\n\n${pr.body ?? "(no description)"}`),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The analyst reads the PR and its diff and writes a brief: each user-facing change with the files
 * that prove it. Writers may only claim what's in the brief, so this is where grounding happens.
 */
export async function buildBrief(pr: PullRequest, files: PullRequestFile[], deps: PipelineDeps, version?: string): Promise<ChangeBrief> {
  const { value } = await runAgentJson(ChangeBriefSchema, {
    role: "analyst",
    projectId: deps.project.id,
    task: briefTask(pr, files, deps, version),
    tools: deps.repoTools,
    harness: deps.harness,
    db: deps.db,
    model: deps.models?.analyst,
  });
  const brief = { ...value, pr: pr.number };
  saveBrief(deps.project.id, brief);
  return brief;
}

export function renderBrief(b: ChangeBrief): string {
  return [
    `# PR #${b.pr}: ${b.title}`,
    "",
    b.summary,
    "",
    `User-facing: ${b.userFacing ? "yes" : "no"}${b.breaking ? " · BREAKING" : ""}`,
    "",
    ...b.changes.map((c) => `- [${c.id}] (${c.kind}) ${c.what}\n  Impact: ${c.userImpact || "none"}\n  Evidence: ${c.evidence.join(", ")}`),
    ...(b.upgradeSteps.length ? ["", "Upgrade steps:", ...b.upgradeSteps.map((s) => `- ${s}`)] : []),
  ].join("\n");
}

function saveBrief(projectId: string, brief: ChangeBrief): void {
  const dir = join(paths.projectData(projectId), "briefs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pr-${brief.pr}.json`), JSON.stringify(brief, null, 2));
  writeFileSync(join(dir, `pr-${brief.pr}.md`), renderBrief(brief));
}
