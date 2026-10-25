import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import type { HarnessConfig, RoleConfig } from "./config.js";
import { discoverSkills, skillBodies, skillsIndex } from "./skills.js";

/**
 * The system prompt is a fixed, ordered list of named sections. Same inputs → same text → same
 * prefix, which keeps provider prompt caches warm. Anything that changes per task (the PR, the
 * date, the draft) goes in the user message, after this prefix, never inside it.
 */
export const SECTION_ORDER = ["base", "project", "audience", "voice", "glossary", "lessons", "skills", "environment"] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

export interface Section {
  name: SectionName;
  text: string;
  hash: string;
}

export interface AssembledPrompt {
  instructions: string;
  sections: Section[];
  /** Hash of every section plus the role config: identifies the harness version a run used. */
  harnessVersion: string;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function readIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}

/** Section bodies for a role in a project, read from prompts/ and projects/<id>/. Missing files are skipped. */
export function loadSections(role: string, projectId: string | undefined, extra: Partial<Record<SectionName, string>> = {}): Partial<Record<SectionName, string>> {
  const base = readIfExists(join(paths.prompts, `${role}.md`));
  const project = projectId ? paths.projectDir(projectId) : undefined;
  const fromProject = (file: string) => (project ? readIfExists(join(project, file)) : undefined);
  return {
    base,
    project: fromProject("profile.md"),
    audience: fromProject("audience.md"),
    voice: fromProject("voice.md"),
    glossary: fromProject("glossary.md"),
    lessons: fromProject("lessons.md"),
    ...extra,
  };
}

/** Harness version of every role for a project, as `runAgent` would compute it. */
export function harnessVersions(projectId: string, harness: HarnessConfig): Record<string, string> {
  const skills = discoverSkills(projectId);
  const out: Record<string, string> = {};
  for (const [role, rc] of Object.entries(harness.roles)) {
    const sections = { ...loadSections(role, projectId), ...(rc.tools.includes("load_skill") ? { skills: skillsIndex(skills) } : {}) };
    out[role] = assemblePrompt(sections, rc, rc.tools.includes("load_skill") ? skillBodies(skills) : []).harnessVersion;
  }
  return out;
}

/**
 * `loadable` is content the role can pull in during the run (skill bodies): not in the prompt, but
 * part of the harness, so changing a skill changes the version just like changing a prompt.
 */
export function assemblePrompt(bodies: Partial<Record<SectionName, string>>, rc: RoleConfig, loadable: string[] = []): AssembledPrompt {
  const sections: Section[] = [];
  for (const name of SECTION_ORDER) {
    const text = bodies[name]?.trim();
    if (text) sections.push({ name, text, hash: sha(text) });
  }
  const instructions = sections.map((s) => `<${s.name}>\n${s.text}\n</${s.name}>`).join("\n\n");
  const version: Record<string, unknown> = { sections: sections.map((s) => [s.name, s.hash]), rc };
  if (loadable.length) version.loadable = sha(loadable.join("\n"));
  const harnessVersion = sha(JSON.stringify(version));
  return { instructions, sections, harnessVersion };
}
