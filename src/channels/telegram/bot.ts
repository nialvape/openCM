import { Bot, type Context } from "grammy";
import { ConfigError, type HarnessConfig, type ProjectConfig } from "../../core/config.js";
import { scrubSecrets } from "../../core/policy.js";
import { githubClient } from "../../sources/github/client.js";
import { repoTools } from "../../tools/repo.js";
import { db } from "../../store/db.js";
import { handleOwnerMessage, resetSession, statusSummary } from "./chat.js";

/** Telegram's limit per message is 4096 characters; leave room. */
const MAX_MESSAGE = 4000;

export function splitMessage(text: string, max = MAX_MESSAGE): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // Prefer breaking at a paragraph, then a line, then a space.
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function readBotEnv(env = process.env): { token: string; ownerId: number } {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new ConfigError("Set TELEGRAM_BOT_TOKEN in .env (from @BotFather).");
  const ownerId = Number(env.TELEGRAM_OWNER_ID);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new ConfigError("Set TELEGRAM_OWNER_ID in .env to your numeric Telegram user id (ask @userinfobot).");
  }
  if (env.TELEGRAM_WEBHOOK_URL?.trim()) {
    throw new ConfigError("Webhook mode isn't implemented yet. Leave TELEGRAM_WEBHOOK_URL empty to use long polling.");
  }
  return { token, ownerId };
}

/** Only the owner, only in a private chat. Everyone else gets no answer at all. */
export const isOwner = (ctx: Pick<Context, "from" | "chat">, ownerId: number) => ctx.from?.id === ownerId && ctx.chat?.type === "private";

const HELP = `I'm the community manager agent for this project. Ask me about recent changes, a PR, or to draft a post.

/status  runs and spend
/new  start a fresh conversation (forgets this chat's context)
/help  this message`;

/**
 * Long-polling bot: it only makes outgoing requests to Telegram, so nothing on this machine is
 * exposed. One owner; messages from anyone else are ignored and logged.
 */
export async function startBot(project: ProjectConfig, harness: HarnessConfig): Promise<void> {
  const { token, ownerId } = readBotEnv();
  const bot = new Bot(token);
  const store = db();
  const tools = repoTools(githubClient(project.repo));

  bot.use(async (ctx, next) => {
    if (isOwner(ctx, ownerId)) return next();
    console.warn(`ignored update from user ${ctx.from?.id ?? "?"} in ${ctx.chat?.type ?? "?"} chat`);
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));
  bot.command("status", (ctx) => ctx.reply(statusSummary(store)));
  bot.command("new", async (ctx) => {
    resetSession(store, String(ctx.chat.id));
    await ctx.reply("Fresh conversation. What do you want to look at?");
  });

  bot.on("message:text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const send = async (text: string) => {
      for (const part of splitMessage(text)) await ctx.reply(part);
    };
    // Telegram shows "typing…" for ~5 s per call; refresh it while the agent works.
    const typing = setInterval(() => void ctx.replyWithChatAction("typing").catch(() => {}), 4500);
    void ctx.replyWithChatAction("typing").catch(() => {});
    try {
      const reply = await handleOwnerMessage(chatId, ctx.message.text, send, { project, harness, db: store, repoTools: tools });
      await send(reply);
    } catch (e) {
      const message = scrubSecrets(e instanceof Error ? e.message : String(e));
      console.error(`chat error: ${message}`);
      await ctx.reply(`Error: ${message}`);
    } finally {
      clearInterval(typing);
    }
  });

  bot.on("message", (ctx) => ctx.reply("For now I only read text messages."));
  bot.catch((err) => console.error(`telegram error: ${scrubSecrets(String(err.error))}`));

  // A webhook left over from earlier tests would block polling.
  await bot.api.deleteWebhook();
  await bot.api.setMyCommands([
    { command: "status", description: "Runs and spend" },
    { command: "new", description: "Start a fresh conversation" },
    { command: "help", description: "What I can do" },
  ]);

  const stop = () => void bot.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bot.start({
    onStart: (me) => console.log(`@${me.username} is listening for ${project.id} (${project.repo}); owner ${ownerId}. Ctrl+C to stop.`),
  });
}
