/** Fixtures shared by tests: mock model responses, a fake GitHub client and a project config. */
import { MockLanguageModelV4 } from "ai/test";
import type { HarnessConfig, ProjectConfig } from "./core/config.js";
import { ProjectConfigSchema } from "./core/config.js";
import type { GitHubClient, PullRequest, PullRequestFile } from "./sources/github/client.js";
import { GitHubError } from "./sources/github/client.js";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

export const answer = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });

export const toolCall = (toolName: string, input: object, id = `c-${toolName}`) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  usage,
  warnings: [],
});

export const mockModel = (...responses: ReturnType<typeof answer | typeof toolCall>[]) => new MockLanguageModelV4({ doGenerate: responses });

const role = (tools: string[] = []) => ({ model: "mock:m", tools, maxSteps: 6, maxCostUsd: 1, plan: false });

export function testHarness(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    roles: {
      analyst: role(["get_pr", "repo_diff"]),
      writer: role(),
      critic: role(),
      reviewer: role(),
      reflect: role(),
      chat: role(["get_pr", "send_message"]),
      compactor: role(),
    },
    maxToolOutputChars: 5000,
    pricing: {},
    decisions: { model: "mock:d", thresholds: { default: 0.8 }, historySize: 10 },
    chat: { compactAtChars: 100_000, keepRecentTurns: 3 },
    x: { prices: { post: 0.015, postWithLink: 0.2, read: 0.005 }, maxSpendPerDayUsd: 1, metricsAfterHours: [24, 168] },
    memory: { examplesPerDraft: 3, maxExamples: 30, reflectAfter: 3 },
    ...overrides,
  } as HarnessConfig;
}

export function testProject(overrides: Record<string, unknown> = {}): ProjectConfig {
  return ProjectConfigSchema.parse({
    id: "demo",
    repo: "o/r",
    language: "es-AR",
    prefilter: { ignorePaths: [".github/**"], ignoreLabels: ["ci"] },
    ...overrides,
  });
}

export function pr(number: number, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `PR ${number}`,
    body: "description",
    state: "closed",
    merged_at: `2026-10-2${number % 10}T12:00:00Z`,
    updated_at: `2026-10-2${number % 10}T12:00:00Z`,
    html_url: `https://github.com/o/r/pull/${number}`,
    user: { login: "dev" },
    labels: [],
    additions: 1,
    deletions: 0,
    changed_files: 1,
    base: { ref: "main" },
    head: { ref: "feature" },
    ...extra,
  };
}

/** GitHub client answering from an in-memory map of paths (query strings ignored), recording calls. */
export function fakeGitHub(routes: Record<string, unknown>, repo = "o/r"): GitHubClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    repo,
    calls,
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      const key = path.split("?")[0];
      if (!(key in routes)) throw new GitHubError(`Not found on GitHub: ${path}`);
      return structuredClone(routes[key]) as T;
    },
  };
}

export function prRoutes(p: PullRequest, files: PullRequestFile[]): Record<string, unknown> {
  return { [`/repos/o/r/pulls/${p.number}`]: p, [`/repos/o/r/pulls/${p.number}/files`]: files };
}
