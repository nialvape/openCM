import { Bot, InputFile, type Context, type InlineKeyboard } from "grammy";
import { ConfigError } from "../../core/config.js";
import { scrubSecrets } from "../../core/policy.js";
import { pipelineDeps } from "../../pipeline/deps.js";
import { advance, maybeDigest, type Outcome } from "../../pipeline/flow.js";
import {
  answerFormat,
  approveDraft,
  getDraft,
  noteRejection,
  pendingDrafts,
  reformatDraft,
  rejectDraft,
  replaceDraftText,
  reviseDraft,
} from "../../pipeline/review.js";
import { pendingEvents, poll } from "../../pipeline/watch.js";
import type { PipelineDeps } from "../../pipeline/types.js";
import { eventsForDraft, eventsWithStatus } from "../../store/events.js";
import { draftCard, EDIT_HELP, formatQuestion, parseCallback } from "./cards.js";
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

const HELP = `I'm the community manager agent for this project. I watch the repo, and when a PR is merged I send you a draft to approve, edit or reject. You can also ask me about recent changes or to draft something.

/run  check GitHub for merged PRs now
/drafts  show drafts and questions waiting for you
/digest  draft a digest of the held changes now
/status  runs and spend
/new  start a fresh conversation (forgets this chat's context)
/help  this message`;

/** What the owner's next text message means, when it isn't a question for the chat agent. */
type Pending = { kind: "edit"; draftId: string } | { kind: "reason"; draftId: string };

const errorText = (e: unknown) => scrubSecrets(e instanceof Error ? e.message : String(e));
const clip = (text: string) => (text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 20)}\n…[cut]` : text);

/**
 * Long-polling bot that also watches the repo. Every `watch.pollMinutes` it checks GitHub, moves
 * new merges through the pipeline and sends the owner what needs them: a draft card, a format
 * question or a failure. Nothing on this machine is exposed; one owner, everyone else ignored.
 */
export async function startBot(projectId: string): Promise<void> {
  const { token, ownerId } = readBotEnv();
  const deps: PipelineDeps = pipelineDeps(projectId);
  const { project, harness } = deps;
  const bot = new Bot(token);
  const pending = new Map<string, Pending>();

  const send = (text: string, keyboard?: InlineKeyboard) => bot.api.sendMessage(ownerId, clip(text), keyboard ? { reply_markup: keyboard } : {});

  async function sendDraft(draftId: string): Promise<void> {
    const d = getDraft(deps, draftId);
    if (!d) return;
    const card = draftCard(d, eventsForDraft(deps.db, draftId));
    await send(card.text, card.keyboard);
  }

  /** Turns a pipeline outcome into the message the owner needs, if any. */
  async function deliver(o: Outcome): Promise<void> {
    switch (o.kind) {
      case "drafted":
        if (o.patchNotes) await bot.api.sendDocument(ownerId, new InputFile(o.patchNotes.path), { caption: `Patch notes ${o.patchNotes.version}` });
        return sendDraft(o.draft.id);
      case "ask_format": {
        const q = formatQuestion(o.event, o.decision);
        await send(q.text, q.keyboard);
        return;
      }
      case "held":
        await send(`⏸ #${o.event.pr} held for the next digest (${o.reason}).`);
        return;
      case "failed":
        await send(`⚠️ #${o.event.pr} failed: ${o.reason}\nI'll retry on the next check.`);
        return;
      case "skipped":
        console.log(`#${o.event.pr} skipped: ${o.reason}`);
    }
  }

  let running = false;
  /** One watch pass. Returns how many events it moved; overlapping passes are skipped. */
  async function cycle(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const added = await poll(deps);
      if (added.length) console.log(`${added.length} newly merged PR(s): ${added.map((e) => `#${e.pr}`).join(", ")}`);
      const events = pendingEvents(deps);
      for (const e of events) await deliver(await advance(e, deps));
      const digest = await maybeDigest(deps);
      if (digest) await deliver(digest);
      return events.length;
    } catch (e) {
      console.error(`watch error: ${errorText(e)}`);
      await send(`⚠️ Checking GitHub failed: ${errorText(e)}`).catch(() => {});
      return 0;
    } finally {
      running = false;
    }
  }

  bot.use(async (ctx, next) => {
    if (isOwner(ctx, ownerId)) return next();
    console.warn(`ignored update from user ${ctx.from?.id ?? "?"} in ${ctx.chat?.type ?? "?"} chat`);
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));
  bot.command("status", (ctx) => ctx.reply(statusSummary(deps.db)));
  bot.command("new", async (ctx) => {
    resetSession(deps.db, String(ctx.chat.id));
    pending.delete(String(ctx.chat.id));
    await ctx.reply("Fresh conversation. What do you want to look at?");
  });
  bot.command("run", async (ctx) => {
    await ctx.reply("Checking GitHub…");
    const n = await cycle();
    if (n === 0) await ctx.reply("Nothing new to process.");
  });
  bot.command("digest", async (ctx) => {
    const held = eventsWithStatus(deps.db, project.id, "held");
    if (held.length === 0) return void (await ctx.reply("Nothing is held for a digest."));
    await ctx.reply(`Drafting a digest of ${held.length} held change(s)…`);
    const o = await maybeDigest(deps, true);
    if (o) await deliver(o);
  });
  bot.command("drafts", async (ctx) => {
    const drafts = pendingDrafts(deps);
    const questions = eventsWithStatus(deps.db, project.id, "awaiting_format");
    if (!drafts.length && !questions.length) return void (await ctx.reply("Nothing is waiting for you."));
    for (const d of drafts) await sendDraft(d.id);
    for (const e of questions) {
      const q = formatQuestion(e, { reason: e.reason ?? "waiting for your choice" });
      await send(q.text, q.keyboard);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const cb = parseCallback(ctx.callbackQuery.data);
    if (!cb) return void (await ctx.answerCallbackQuery({ text: "Unknown button" }));
    const chatId = String(ctx.chat?.id ?? ownerId);
    // Buttons are removed once used, so a card can't be approved twice.
    const done = async (status: string) => {
      await ctx.editMessageReplyMarkup().catch(() => {});
      await ctx.reply(status);
    };
    try {
      if (cb.kind === "format") {
        await ctx.answerCallbackQuery({ text: `${cb.format}: working on it` });
        await ctx.editMessageReplyMarkup().catch(() => {});
        await deliver(await answerFormat(deps, cb.eventId, cb.format));
        return;
      }
      switch (cb.action) {
        case "approve":
          await ctx.answerCallbackQuery({ text: "Approved" });
          approveDraft(deps, cb.draftId);
          await done("✅ Approved. Publishing to X isn't set up yet; it's saved as approved.");
          return;
        case "reject":
          await ctx.answerCallbackQuery({ text: "Rejected" });
          rejectDraft(deps, cb.draftId);
          pending.set(chatId, { kind: "reason", draftId: cb.draftId });
          await done("🗑 Rejected. If you tell me why in your next message, I'll learn from it (or send /new to skip).");
          return;
        case "edit":
          await ctx.answerCallbackQuery();
          if (getDraft(deps, cb.draftId)?.status !== "pending") return void (await ctx.reply("That draft isn't pending anymore."));
          pending.set(chatId, { kind: "edit", draftId: cb.draftId });
          await ctx.reply(EDIT_HELP);
          return;
        default: {
          const format = cb.action.slice(3) as "skip" | "hold" | "post" | "thread";
          await ctx.answerCallbackQuery({ text: `Switching to ${format}…` });
          await ctx.editMessageReplyMarkup().catch(() => {});
          for (const o of await reformatDraft(deps, cb.draftId, format)) await deliver(o);
          if (format === "skip") await ctx.reply("Skipped.");
        }
      }
    } catch (e) {
      await ctx.reply(`⚠️ ${errorText(e)}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;
    const waiting = pending.get(chatId);
    const typing = setInterval(() => void ctx.replyWithChatAction("typing").catch(() => {}), 4500);
    void ctx.replyWithChatAction("typing").catch(() => {});
    try {
      if (waiting?.kind === "reason") {
        pending.delete(chatId);
        noteRejection(deps, waiting.draftId, text);
        await ctx.reply("Noted, thanks.");
        return;
      }
      if (waiting?.kind === "edit") {
        pending.delete(chatId);
        if (text.startsWith("=")) {
          replaceDraftText(deps, waiting.draftId, text.slice(1).trim());
          await sendDraft(waiting.draftId);
        } else {
          const { draft } = await reviseDraft(deps, waiting.draftId, text);
          await sendDraft(draft.id);
        }
        return;
      }
      const reply = await handleOwnerMessage(chatId, text, async (t) => void (await ctx.reply(clip(t))), {
        project,
        harness,
        db: deps.db,
        repoTools: deps.repoTools,
      });
      for (const part of splitMessage(reply)) await ctx.reply(part);
    } catch (e) {
      console.error(`chat error: ${errorText(e)}`);
      await ctx.reply(`Error: ${errorText(e)}`);
    } finally {
      clearInterval(typing);
    }
  });

  bot.on("message", (ctx) => ctx.reply("For now I only read text messages."));
  bot.catch((err) => console.error(`telegram error: ${scrubSecrets(String(err.error))}`));

  // A webhook left over from earlier tests would block polling.
  await bot.api.deleteWebhook();
  await bot.api.setMyCommands([
    { command: "run", description: "Check GitHub for merged PRs now" },
    { command: "drafts", description: "Drafts and questions waiting for you" },
    { command: "digest", description: "Draft a digest of held changes" },
    { command: "status", description: "Runs and spend" },
    { command: "new", description: "Start a fresh conversation" },
    { command: "help", description: "What I can do" },
  ]);

  const timer = setInterval(() => void cycle(), project.watch.pollMinutes * 60_000);
  const stop = () => {
    clearInterval(timer);
    void bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bot.start({
    onStart: (me) => {
      console.log(`@${me.username} is watching ${project.repo} every ${project.watch.pollMinutes} min for owner ${ownerId}. Ctrl+C to stop.`);
      void cycle();
    },
  });
}
