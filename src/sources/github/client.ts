/**
 * Thin GitHub REST client: only the calls openCM uses, typed with only the fields it reads.
 * Knows nothing about models or tools.
 */
export class GitHubError extends Error {
  name = "GitHubError";
}

export interface GitHubClient {
  repo: string;
  get<T>(path: string, accept?: string): Promise<T>;
}

export function githubClient(repo: string, token = process.env.GITHUB_TOKEN): GitHubClient {
  return {
    repo,
    async get<T>(path: string, accept = "application/vnd.github+json"): Promise<T> {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: {
          accept,
          "x-github-api-version": "2022-11-28",
          "user-agent": "opencm",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.status === 404) throw new GitHubError(`Not found on GitHub: ${path}. Check the path, ref or number.`);
      if (res.status === 403 || res.status === 429) {
        throw new GitHubError(`GitHub refused or rate-limited ${path} (${res.status}). ${token ? "Wait and retry." : "Set GITHUB_TOKEN in .env."}`);
      }
      if (!res.ok) throw new GitHubError(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as T;
    },
  };
}

export interface ContentEntry {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  size: number;
}

export interface FileContent {
  type: "file";
  path: string;
  size: number;
  encoding: string;
  content: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  updated_at: string;
  html_url: string;
  user: { login: string } | null;
  labels: { name: string }[];
  additions: number;
  deletions: number;
  changed_files: number;
  base: { ref: string };
  merge_commit_sha?: string | null;
  head: { ref: string };
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff of the file; GitHub omits it for binary or very large files. */
  patch?: string;
}

export interface CodeSearchResult {
  total_count: number;
  items: { path: string; text_matches?: { fragment: string }[] }[];
}
