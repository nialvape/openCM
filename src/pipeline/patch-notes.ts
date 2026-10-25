import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../core/loop.js";
import { measurePostsTool } from "../tools/measure.js";
import { paths } from "../core/paths.js";
import { asUntrustedData } from "../core/policy.js";
import { eventsBetween, previousRelease, type ChangeEvent } from "../store/events.js";
import type { ChangeBrief } from "./brief.js";
import type { PipelineDeps } from "./types.js";

export interface PatchNotes {
  version: string;
  path: string;
  text: string;
  prs: number[];
}

/** Briefs of every PR since the previous release, up to and including the release PR. */
export function briefsForRelease(release: ChangeEvent, deps: PipelineDeps): ChangeBrief[] {
  const previous = previousRelease(deps.db, deps.project.id, release.mergedAt);
  return eventsBetween(deps.db, deps.project.id, previous?.mergedAt ?? "", release.mergedAt)
    .map((e) => e.brief as ChangeBrief | undefined)
    .filter((b): b is ChangeBrief => !!b && b.userFacing);
}

export async function buildPatchNotes(release: ChangeEvent, deps: PipelineDeps): Promise<PatchNotes> {
  if (!release.version) throw new Error(`PR #${release.pr} is not a release`);
  const briefs = briefsForRelease(release, deps);
  const result = await runAgent({
    role: "writer",
    projectId: deps.project.id,
    task: [
      `Write the patch notes for version ${release.version} of ${deps.project.repo}, released in PR #${release.pr}.`,
      `Load the patch-notes skill first. Write in ${deps.project.language}. Answer with only the patch notes in Markdown.`,
      "This is a document, not posts: there's no character limit, so don't measure it.",
      briefs.length ? "" : "No user-facing changes were recorded since the previous release; write a short maintenance release note.",
      asUntrustedData("change briefs since the previous release", JSON.stringify(briefs, null, 2)),
    ].join("\n"),
    // The writer role's allowlist includes it; patch notes are a document, so it just goes unused.
    tools: { measure_posts: measurePostsTool() },
    harness: deps.harness,
    db: deps.db,
    model: deps.models?.writer,
  });
  if (result.status !== "done" || !result.text.trim()) throw new Error(`Patch notes for ${release.version} failed (${result.error ?? result.status}; run ${result.runId})`);
  const dir = join(paths.projectData(deps.project.id), "patch-notes");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${release.version}.md`);
  writeFileSync(path, result.text.trim() + "\n");
  return { version: release.version, path, text: result.text.trim(), prs: briefs.map((b) => b.pr) };
}
