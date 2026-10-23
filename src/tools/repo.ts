import { z } from "zod";
import type { AgentTool } from "../core/loop.js";
import { asUntrustedData } from "../core/policy.js";
import type { CodeSearchResult, ContentEntry, FileContent, GitHubClient, PullRequest, PullRequestFile } from "../sources/github/client.js";

/** Lines returned per repo_read_file call; the model pages with startLine. */
const READ_PAGE_LINES = 300;

const encodePath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
const refQuery = (ref?: string) => (ref ? `?ref=${encodeURIComponent(ref)}` : "");

/**
 * Read-only tools over the tracked repo, through the GitHub API. Everything that comes from the
 * repo (code, PR text) is fenced as untrusted data: it may contain text written to steer the model.
 */
export function repoTools(gh: GitHubClient): Record<string, AgentTool> {
  const r = gh.repo;
  return {
    repo_list: {
      description: "Lists files and folders at a path of the tracked repo. Start with path '' for the root.",
      inputSchema: z.object({
        path: z.string().describe("Folder path relative to the repo root, e.g. 'src/oauth'. Empty for the root."),
        ref: z.string().optional().describe("Branch, tag or commit; default branch if omitted"),
      }),
      execute: async ({ path, ref }: { path: string; ref?: string }) => {
        const entries = await gh.get<ContentEntry[] | ContentEntry>(`/repos/${r}/contents/${encodePath(path)}${refQuery(ref)}`);
        if (!Array.isArray(entries)) return `'${path}' is a file, not a folder. Use repo_read_file.`;
        return entries.map((e) => (e.type === "dir" ? `${e.path}/` : `${e.path} (${e.size} bytes)`)).join("\n") || "(empty folder)";
      },
    },

    repo_read_file: {
      description: `Reads a file of the tracked repo, ${READ_PAGE_LINES} lines at a time. Use startLine to read further.`,
      inputSchema: z.object({
        path: z.string().describe("File path relative to the repo root, e.g. 'README.md'"),
        startLine: z.number().int().positive().optional().describe("First line to return, 1-based. Default 1."),
        ref: z.string().optional().describe("Branch, tag or commit; default branch if omitted"),
      }),
      execute: async ({ path, startLine = 1, ref }: { path: string; startLine?: number; ref?: string }) => {
        const file = await gh.get<FileContent | ContentEntry[]>(`/repos/${r}/contents/${encodePath(path)}${refQuery(ref)}`);
        if (Array.isArray(file)) return `'${path}' is a folder. Use repo_list.`;
        if (file.encoding !== "base64") return `'${path}' is too large to read through the API (${file.size} bytes).`;
        const lines = Buffer.from(file.content, "base64").toString("utf8").split("\n");
        const end = Math.min(lines.length, startLine - 1 + READ_PAGE_LINES);
        const page = lines.slice(startLine - 1, end).map((l, i) => `${startLine + i}: ${l}`).join("\n");
        const more = end < lines.length ? `\n[lines ${startLine}-${end} of ${lines.length}; call again with startLine ${end + 1} for more]` : "";
        return asUntrustedData(`file ${path}`, page) + more;
      },
    },

    repo_search: {
      description: "Searches code in the tracked repo (GitHub code search). Returns matching paths with snippets.",
      inputSchema: z.object({ query: z.string().describe("Words or identifiers to find, e.g. 'regional login'") }),
      execute: async ({ query }: { query: string }) => {
        const q = encodeURIComponent(`${query} repo:${r}`);
        const res = await gh.get<CodeSearchResult>(`/search/code?q=${q}&per_page=15`, "application/vnd.github.text-match+json");
        if (res.items.length === 0) return `No matches for '${query}'.`;
        const body = res.items.map((i) => [i.path, ...(i.text_matches ?? []).map((m) => `  …${m.fragment.replace(/\s+/g, " ").trim()}…`)].join("\n")).join("\n");
        return asUntrustedData(`search results for '${query}'`, `${res.total_count} matches\n${body}`);
      },
    },

    list_prs: {
      description: "Lists the most recently merged pull requests of the tracked repo, newest first.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(30).optional().describe("How many, default 10") }),
      execute: async ({ limit = 10 }: { limit?: number }) => {
        // Closed PRs include unmerged ones; fetch extra and keep the merged.
        const prs = await gh.get<PullRequest[]>(`/repos/${r}/pulls?state=closed&sort=updated&direction=desc&per_page=${Math.min(100, limit * 3)}`);
        const merged = prs.filter((p) => p.merged_at).sort((a, b) => b.merged_at!.localeCompare(a.merged_at!)).slice(0, limit);
        if (merged.length === 0) return "No merged pull requests found.";
        return asUntrustedData("merged pull requests", merged.map((p) => `#${p.number} ${p.merged_at!.slice(0, 10)} ${p.title}`).join("\n"));
      },
    },

    get_pr: {
      description: "Gets one pull request: title, description, state, labels and the list of changed files.",
      inputSchema: z.object({ number: z.number().int().positive().describe("PR number, e.g. 16") }),
      execute: async ({ number }: { number: number }) => {
        const [pr, files] = await Promise.all([
          gh.get<PullRequest>(`/repos/${r}/pulls/${number}`),
          gh.get<PullRequestFile[]>(`/repos/${r}/pulls/${number}/files?per_page=100`),
        ]);
        const facts = [
          `#${pr.number} ${pr.state}${pr.merged_at ? `, merged ${pr.merged_at.slice(0, 10)}` : ""} by ${pr.user?.login ?? "unknown"}`,
          `${pr.head.ref} → ${pr.base.ref}, ${pr.changed_files} files, +${pr.additions} −${pr.deletions}`,
          `labels: ${pr.labels.map((l) => l.name).join(", ") || "none"}`,
          pr.html_url,
          "files:",
          ...files.map((f) => `  ${f.status} ${f.filename} (+${f.additions} −${f.deletions})`),
        ].join("\n");
        return `${facts}\n${asUntrustedData(`PR #${number} title and description`, `${pr.title}\n\n${pr.body ?? "(no description)"}`)}`;
      },
    },
  };
}
