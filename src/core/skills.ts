import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { paths } from "./paths.js";

export type SkillSource = "core" | "project";

export interface Skill {
  name: string;
  description: string;
  source: SkillSource;
  dir: string;
  body: string;
}

export class SkillError extends Error {
  name = "SkillError";
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses a SKILL.md: YAML frontmatter with `name` and `description`, then the body. */
export function parseSkillFile(text: string, file: string): { name: string; description: string; body: string } {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new SkillError(`${file} has no frontmatter. Start it with ---, name:, description:, ---`);
  const meta = parse(m[1]) as { name?: unknown; description?: unknown } | null;
  if (typeof meta?.name !== "string" || typeof meta?.description !== "string") {
    throw new SkillError(`${file} frontmatter needs string 'name' and 'description'`);
  }
  return { name: meta.name, description: meta.description.trim(), body: m[2].trim() };
}

function readSkillsDir(dir: string, source: SkillSource): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const parsed = parseSkillFile(readFileSync(file, "utf8"), file);
    if (parsed.name !== entry.name) throw new SkillError(`${file} is named '${parsed.name}' but its folder is '${entry.name}'`);
    out.push({ ...parsed, source, dir: join(dir, entry.name) });
  }
  return out;
}

/**
 * Core skills from skills/, project skills from projects/<id>/skills/. A project skill with the same
 * name replaces the core one. Only these two local folders are read: no remote or downloaded skills.
 */
export function discoverSkills(projectId?: string, roots: { core: string; project?: string } = { core: paths.skills, project: projectId ? join(paths.projectDir(projectId), "skills") : undefined }): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  for (const s of readSkillsDir(roots.core, "core")) skills.set(s.name, s);
  if (roots.project) for (const s of readSkillsDir(roots.project, "project")) skills.set(s.name, s);
  return skills;
}

/** The only part of the skills that is always in context: one line per skill. Bodies load on demand. */
export function skillsIndex(skills: Map<string, Skill>): string | undefined {
  if (skills.size === 0) return undefined;
  const lines = [...skills.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- ${s.name}: ${s.description}`);
  return ["Skills available. Call load_skill with the name to read one before doing that kind of work:", ...lines].join("\n");
}
