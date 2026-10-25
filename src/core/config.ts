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
  /** Cap per model call: a runaway generation stops here instead of costing dollars. */
  maxOutputTokens: z.number().int().positive().default(4000),
  /** Seconds one model call may take before it is aborted. */
  stepTimeoutSec: z.number().positive().default(180),
  /**
   * Reasoning effort per call. Omitted = the provider default. Writers do better low: given room,
   * reasoning models draft whole threads in their thinking and count characters by hand until they run out.
   */
  reasoning: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
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

const ChatConfigSchema = z.object({
  compactAtChars: z.number().int().positive(),
  keepRecentTurns: z.number().int().positive(),
});

const XConfigSchema = z.object({
  /** USD per request, from the X API pay-per-use price list. */
  prices: z.object({ post: z.number().nonnegative(), postWithLink: z.number().nonnegative(), read: z.number().nonnegative() }),
  /** Publishing stops for the day once this much was spent on posts. */
  maxSpendPerDayUsd: z.number().nonnegative(),
  /** Hours after posting when metrics are read (each read costs prices.read per post). */
  metricsAfterHours: z.array(z.number().positive()),
});

const MemoryConfigSchema = z.object({
  /** Approved examples shown to the writer per draft, best first. */
  examplesPerDraft: z.number().int().nonnegative(),
  /** Examples kept per project; past this the lowest-scored are evicted. */
  maxExamples: z.number().int().positive(),
  /** Edited or rejected drafts that trigger the reflect job. */
  reflectAfter: z.number().int().positive(),
});

export const HarnessConfigSchema = z.object({
  roles: z.record(z.string(), RoleConfigSchema),
  maxToolOutputChars: z.number().int().positive(),
  pricing: z.record(z.string(), PriceSchema),
  decisions: DecisionsConfigSchema,
  chat: ChatConfigSchema,
  x: XConfigSchema,
  memory: MemoryConfigSchema,
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
  watch: z
    .object({
      /** Minutes between checks for newly merged PRs while the bot runs. */
      pollMinutes: z.number().positive().default(5),
      /** First run only: PRs merged after this ISO date are processed. Default: the last 24 hours. */
      startFrom: z.string().datetime({ offset: true }).optional(),
    })
    .prefault({}),
  posting: z
    .object({
      /** Posts and threads per day; past this, new changes are held for the digest. */
      maxPostsPerDay: z.number().int().nonnegative().default(3),
      /** Held changes that trigger a digest. */
      digestMinItems: z.number().int().positive().default(3),
    })
    .prefault({}),
  /** Words or phrases a post must never contain (checked without a model). */
  bannedTerms: z.array(z.string()).default([]),
  /** Files whose version line marks a release, e.g. package.json. `pattern` captures the version. */
  versionFiles: z
    .array(z.object({ path: z.string(), pattern: z.string() }))
    .default([{ path: "package.json", pattern: '"version"\\s*:\\s*"([^"]+)"' }]),
  harness: z.record(z.string(), z.unknown()).default({}),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type ReasoningEffort = NonNullable<RoleConfig["reasoning"]>;
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type DecisionsConfig = z.infer<typeof DecisionsConfigSchema>;
export type XConfig = z.infer<typeof XConfigSchema>;
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
