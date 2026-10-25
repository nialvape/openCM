import twitter from "twitter-text";
import { z } from "zod";
import type { AgentTool } from "../core/loop.js";

/** X's hard limit, in weighted characters (emojis and CJK count 2, any URL 23). */
export const X_LIMIT = 280;

export interface Measurement {
  post: number;
  length: number;
  /** Negative when over the limit. */
  left: number;
  fits: boolean;
  links: string[];
}

export function measure(texts: string[]): Measurement[] {
  return texts.map((text, i) => {
    const length = twitter.parseTweet(text).weightedLength;
    return { post: i + 1, length, left: X_LIMIT - length, fits: length <= X_LIMIT, links: twitter.extractUrls(text) };
  });
}

/** What the model reads: one line per post, and a clear "done" when everything fits. */
export function describeMeasurements(ms: Measurement[]): string {
  const lines = ms.map((m) =>
    m.fits
      ? `post ${m.post}: ${m.length}/${X_LIMIT}, fits${m.links.length ? ` (but has a link: ${m.links.join(", ")})` : ""}`
      : `post ${m.post}: ${m.length}/${X_LIMIT}, OVER by ${-m.left}: shorten it by at least ${-m.left}`,
  );
  const allFit = ms.every((m) => m.fits);
  return [...lines, allFit ? "All posts fit. Stop measuring and give your answer now." : "Shorten only the posts marked OVER, then measure once more."].join("\n");
}

/**
 * Character counting as a tool. Models count characters badly (they see tokens), and reasoning
 * models given room count by hand in their thinking until they run out; this gives them X's exact
 * count instead. It's never cut off while a post is over: that made the writer hand in a post that
 * was too long, and the shortening done afterwards lost the corrections it had just applied. The
 * role's step budget bounds the calls, and "all posts fit" tells it to stop.
 */
export function measurePostsTool(): AgentTool<{ posts: string[] }> {
  return {
    description: `Measures posts exactly as X counts them (emojis count 2, any link or domain name 23) and says which ones are over ${X_LIMIT}. The only valid way to know a post's length.`,
    inputSchema: z.object({
      posts: z.array(z.string()).min(1).describe('The post texts in order, e.g. ["Ya podés…", "Para probarlo…"]'),
    }),
    execute: async ({ posts }) => describeMeasurements(measure(posts)),
  };
}
