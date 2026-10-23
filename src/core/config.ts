import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { paths } from "./paths.js";

export const RoleConfigSchema = z.object({
  model: z.string().regex(/^[a-z0-9-]+:.+$/, "model must be '<provider>:<model>'"),
  tools: z.array(z.string()),
  maxSteps: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  plan: z.boolean(),
});

const PriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
});

const DecisionsConfigSchema = z.object({
  model: z.string().regex(/^[a-z0-9-]+:.+$/, "model must be '<provider>:<model>'"),
  thresholds: z.record(z.string(), z.number().min(0).max(1)).refine((t) => t.default !== undefined, "thresholds.default is required"),
});

export const HarnessConfigSchema = z.object({
  roles: z.record(z.string(), RoleConfigSchema),
  maxToolOutputChars: z.number().int().positive(),
  pricing: z.record(z.string(), PriceSchema),
  decisions: DecisionsConfigSchema,
});

export const ProjectConfigSchema = z.object({
  id: z.string(),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repo must be 'owner/name'"),
  branch: z.string().default("main"),
  language: z.string(),
  channels: z.object({ x: z.object({ linkPolicy: z.enum(["reply", "inline", "none"]).default("reply") }).optional() }).default({}),
  prefilter: z
    .object({ ignorePaths: z.array(z.string()).default([]), ignoreLabels: z.array(z.string()).default([]) })
    .default({ ignorePaths: [], ignoreLabels: [] }),
  harness: z.record(z.string(), z.unknown()).default({}),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type DecisionsConfig = z.infer<typeof DecisionsConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export class ConfigError extends Error {
  name = "ConfigError";
}

function readYaml(file: string): unknown {
  if (!existsSync(file)) throw new ConfigError(`Missing config file: ${file}`);
  return parse(readFileSync(file, "utf8"));
}

/** Deep merge for plain objects; arrays and scalars from `override` replace `base`. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = deepMerge(base[key], value);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid config in ${source}:\n${issues}`);
  }
  return result.data;
}

export function loadProjectConfig(projectId: string): ProjectConfig {
  const file = join(paths.projectDir(projectId), "project.yaml");
  const raw = readYaml(file);
  const config = parseOrThrow(ProjectConfigSchema, raw, file);
  if (config.id !== projectId) throw new ConfigError(`${file} has id '${config.id}' but lives in folder '${projectId}'`);
  return config;
}

/** Harness config = config/default.yaml with the project's `harness:` block merged on top. */
export function loadHarnessConfig(project?: ProjectConfig): HarnessConfig {
  const file = join(paths.root, "config", "default.yaml");
  const merged = deepMerge(readYaml(file), project?.harness ?? {});
  return parseOrThrow(HarnessConfigSchema, merged, project ? `${file} + ${project.id}/project.yaml` : file);
}

export function roleConfig(config: HarnessConfig, role: string): RoleConfig {
  const rc = config.roles[role];
  if (!rc) throw new ConfigError(`Role '${role}' is not defined in config. Known roles: ${Object.keys(config.roles).join(", ")}`);
  return rc;
}
