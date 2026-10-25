import twitter from "twitter-text";
import { z } from "zod";
import type { AgentTool } from "../core/loop.js";

/** X's hard limit, in weighted characters (emojis and CJK count 2, any URL 23). */
export const X_LIMIT = 280;
/** Measurements per writer answer. Past this the model was trimming letter by letter, not converging. */
export const MAX_MEASUREMENTS = 3;

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
 * count instead. Measurements are capped per run, so it can't become a trimming loop either.
 */
export function measurePostsTool(maxCalls = MAX_MEASUREMENTS): AgentTool<{ posts: string[] }> {
  let calls = 0;
  return {
    description: `Measures posts exactly as X counts them (emojis count 2, any link or domain name 23) and says which ones are over ${X_LIMIT}. The only valid way to know a post's length. Use it at most ${maxCalls} times.`,
    inputSchema: z.object({
      posts: z.array(z.string()).min(1).describe('The post texts in order, e.g. ["Ya podés…", "Para probarlo…"]'),
    }),
    execute: async ({ posts }) => {
      calls++;
      if (calls > maxCalls) return `You already measured ${maxCalls} times. Give your answer now; anything still too long will be fixed afterwards.`;
      return describeMeasurements(measure(posts));
    },
  };
}
