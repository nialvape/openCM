import { loadHarnessConfig, loadProjectConfig } from "../core/config.js";
import { githubClient } from "../sources/github/client.js";
import { db } from "../store/db.js";
import { repoTools } from "../tools/repo.js";
import type { PipelineDeps } from "./types.js";

/** Real dependencies for a project: config from disk, the shared database, GitHub with GITHUB_TOKEN. */
export function pipelineDeps(projectId: string): PipelineDeps {
  const project = loadProjectConfig(projectId);
  const gh = githubClient(project.repo);
  return { project, harness: loadHarnessConfig(project), db: db(), gh, repoTools: repoTools(gh, project.prefilter.ignorePaths) };
}
