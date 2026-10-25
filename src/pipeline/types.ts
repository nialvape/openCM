import type { DatabaseSync } from "node:sqlite";
import type { LanguageModel } from "ai";
import type { HarnessConfig, ProjectConfig } from "../core/config.js";
import type { AgentTool } from "../core/loop.js";
import type { GitHubClient } from "../sources/github/client.js";

/** Everything a pipeline step needs. Tests pass mock models per role and a fake GitHub client. */
export interface PipelineDeps {
  project: ProjectConfig;
  harness: HarnessConfig;
  db: DatabaseSync;
  gh: GitHubClient;
  repoTools: Record<string, AgentTool>;
  models?: Partial<Record<string, LanguageModel>>;
}
