import twitter from "twitter-text";
import type { ProjectConfig } from "../core/config.js";
import { scrubSecrets } from "../core/policy.js";
import type { ChangeBrief } from "../pipeline/brief.js";
import type { Draft } from "../pipeline/draft.js";

/** Posts per format the writer may produce. */
export const POSTS_PER_FORMAT: Record<Draft["format"], [min: number, max: number]> = { post: [1, 1], thread: [2, 8], digest: [1, 4] };
const MAX_WEIGHTED_LENGTH = 280;

export interface CheckIssue {
  check: "length" | "link_policy" | "claims" | "banned_term" | "secret" | "shape";
  where: string;
  message: string;
}

/**
 * Deterministic checks a draft must pass before the critic sees it. They're cheap, exact and
 * never fooled; the critic only judges what code can't.
 */
export function runChecks(draft: Draft, briefs: ChangeBrief[], project: ProjectConfig): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const linkPolicy = project.channels.x?.linkPolicy ?? "reply";
  const [min, max] = POSTS_PER_FORMAT[draft.format];
  if (draft.posts.length < min || draft.posts.length > max) {
    issues.push({ check: "shape", where: "draft", message: `A ${draft.format} needs ${min === max ? min : `${min} to ${max}`} posts; this has ${draft.posts.length}.` });
  }

  const knownClaims = new Set(briefs.flatMap((b) => b.changes.map((c) => `${b.pr}:${c.id}`)));
  const texts: [string, string][] = draft.posts.map((p, i) => [`post ${i + 1}`, p.text]);
  if (draft.linkReply) texts.push(["link reply", draft.linkReply]);

  for (const [where, text] of texts) {
    const parsed = twitter.parseTweet(text);
    if (parsed.weightedLength > MAX_WEIGHTED_LENGTH) {
      issues.push({ check: "length", where, message: `${parsed.weightedLength} of ${MAX_WEIGHTED_LENGTH} weighted characters; shorten it by ${parsed.weightedLength - MAX_WEIGHTED_LENGTH}.` });
    }
    const lower = text.toLowerCase();
    for (const term of project.bannedTerms) {
      if (lower.includes(term.toLowerCase())) issues.push({ check: "banned_term", where, message: `Contains the banned term '${term}'.` });
    }
    if (scrubSecrets(text) !== text) issues.push({ check: "secret", where, message: "Contains something that looks like a credential or a tokenized URL." });
  }

  draft.posts.forEach((p, i) => {
    const urls = twitter.extractUrls(p.text);
    // X counts bare domains like github.com/x as links too, and a post with a link costs ~13x more.
    if (urls.length && linkPolicy !== "inline") {
      issues.push({ check: "link_policy", where: `post ${i + 1}`, message: `Links go ${linkPolicy === "reply" ? "only in linkReply" : "nowhere"} for this project; remove ${urls.join(", ")}.` });
    }
    if (p.claims.length === 0) issues.push({ check: "claims", where: `post ${i + 1}`, message: "Every post must list the brief changes it is based on in claims." });
    for (const claim of p.claims) {
      if (!knownClaims.has(claim)) issues.push({ check: "claims", where: `post ${i + 1}`, message: `Claim '${claim}' is not a change in the briefs. Valid: ${[...knownClaims].join(", ")}.` });
    }
  });
  if (draft.linkReply && linkPolicy !== "reply") issues.push({ check: "link_policy", where: "link reply", message: "This project doesn't use a link reply." });
  return issues;
}
