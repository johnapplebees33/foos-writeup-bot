import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";

/**
 * ENV VARS:
 * DISCORD_TOKEN=...
 * GIB_GUILD_ID=...
 * GAME_DAY_CATEGORY_ID=...
 * FOOS_WEBHOOK_URL=...
 *
 * Optional:
 * TEAM_ABBR=LAF
 * TEAM_NAME_TEXT=@Los Angeles Foos
 */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GIB_GUILD_ID = process.env.GIB_GUILD_ID;
const GAME_DAY_CATEGORY_ID = process.env.GAME_DAY_CATEGORY_ID;
const FOOS_WEBHOOK_URL = process.env.FOOS_WEBHOOK_URL;

const TEAM_ABBR = process.env.TEAM_ABBR || "LAF";
const TEAM_NAME_TEXT = process.env.TEAM_NAME_TEXT || "@Los Angeles Foos";

if (!DISCORD_TOKEN || !GIB_GUILD_ID || !GAME_DAY_CATEGORY_ID || !FOOS_WEBHOOK_URL) {
  throw new Error("Missing env vars: DISCORD_TOKEN, GIB_GUILD_ID, GAME_DAY_CATEGORY_ID, FOOS_WEBHOOK_URL");
}

// Dedup state so it won't repost on restarts
const STATE_PATH = path.resolve("./forward_state.json");
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { lastForwardedByThread: {} }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
const state = loadState();
// Track threads confirmed to be Foos games
state.foosThreads = state.foosThreads || {};

async function postToFoos(content) {
  const res = await fetch(FOOS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("Webhook error:", res.status, body);
  }
}

async function isGameDayThread(thread) {
  const parent = thread.parent;
  if (!parent) return false;
  return parent.parentId === GAME_DAY_CATEGORY_ID;
}

// Identify Foos-related messages by scoreboard/team markers
function isFoosGameMessage(text) {
  if (!text) return false;
  if (text.includes(TEAM_NAME_TEXT)) return true;
  if (text.includes(TEAM_ABBR) && /[A-Z]{2,4}\s+\d+\s*-\s*[A-Z]{2,4}\s+\d+/.test(text)) return true;
  if (new RegExp(`^\\s*${TEAM_ABBR}\\s+\\d+\\b`, "m").test(text)) return true;
  return false;
}

// Result block detector (ump result writeup)
const RESULT_BLOCK = /^\s*Pitch:\s*\d{1,4}\s*$.*?^\s*Swing:\s*\d{1,4}\s*$.*?^\s*Diff:\s*\d{1,4}\s*->\s*.+?\s*$/ms;

// Pitcher writeup detector (ump at-bat post)
const PITCHER_ANNOUNCE = /\bOn the mound:\b/i;
const UP_TO_BAT = /\bis up to bat\b|\bwhen you swing\b|\btimer expires\b/i;

// Swing writeup detector (batter post)
const SWING_EXPLICIT = /\bSwing\s*:\s*(\d{1,4})\b/i;
const SWING_INLINE = /\b(?:swing|swung)\s+(\d{1,4})\b/i;
const SWING_STANDALONE_LINE = /^\s*(\d{1,4})\s*$/m;
const ROLE_PING = /<@&\d+>/; // ump/crew role ping

function extractSwingFromText(text) {
  if (!text) return null;

  // Prefer explicit swing formats if present
  let m =
    text.match(/\bSwing\s*:\s*(\d{1,4})\b/i) ||
    text.match(/\b(?:swing|swung)\s+(\d{1,4})\b/i);

  if (m) {
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 1000 ? n : null;
  }

  // Otherwise: ANY integer 1–1000 anywhere (e.g., "793 feet")
  // We ignore numbers inside Discord mentions like <@123...> by only matching plain word-boundary numbers.
  const candidates = [...text.matchAll(/\b(\d{1,4})\b/g)]
    .map(x => parseInt(x[1], 10))
    .filter(n => n >= 1 && n <= 1000);

  if (candidates.length === 0) return null;

  // Heuristic: take the LAST candidate (players usually put the swing near the end)
  return candidates[candidates.length - 1];
}


function likelySwingNumber(text) {
  let m = text.match(SWING_EXPLICIT) || text.match(SWING_INLINE) || text.match(SWING_STANDALONE_LINE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n) || n < 1 || n > 1000) return null;
  return n;
}

function classifyMessage(text) {
  if (RESULT_BLOCK.test(text)) return "UMP_RESULT";
  if (PITCHER_ANNOUNCE.test(text) && UP_TO_BAT.test(text)) return "PITCHER_WRITEUP";

  const swing = extractSwingFromText(text);

  // If they ping the ump/crew role, treat it as a swing (even if the number is embedded like "793 feet")
  if (ROLE_PING.test(text) && swing !== null && text.trim().length >= 25) return "SWING_WRITEUP";

  // Also allow short numeric-only swings like "482"
  if (swing !== null && text.trim().length <= 10) return "SWING_WRITEUP";

  // Otherwise keep it conservative
  return null;
}


function trimBlock(text, max = 1600) {
  const t = (text || "").trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

// Discord client: MUST enable MessageContent intent in Dev Portal
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.guild || message.guild.id !== GIB_GUILD_ID) return;

    const ch = message.channel;
    if (!ch.isThread()) return;
    if (!(await isGameDayThread(ch))) return;

    const content = message.content || "";
    if (!content) return;

    // Only handle messages from Foos games
    // If any message contains Foos markers, mark the whole thread as a Foos game

if (isFoosGameMessage(content)) {
  state.foosThreads[ch.id] = true;
  saveState(state);
}

// Only process messages in threads already confirmed as Foos games
if (!state.foosThreads[ch.id]) return;

    const kind = classifyMessage(content);
    if (!kind) return;

    // Dedup per thread
    const last = state.lastForwardedByThread[ch.id] || "0";
    if (BigInt(message.id) <= BigInt(last)) return;

    const jump = message.url;
    const header =
      kind === "PITCHER_WRITEUP" ? "🎯 **PITCH** (ump writeup)" :
      kind === "SWING_WRITEUP"   ? "⚾ **SWING**" :
                                   "🧾 **RESULT**";

    const out =
      `${header} • **${ch.name}** • [Jump](${jump})\n` +
      "```text\n" + trimBlock(content) + "\n```";

    await postToFoos(out);

    state.lastForwardedByThread[ch.id] = message.id;
    saveState(state);
  } catch (err) {
    console.error("handler error:", err);
  }
});

client.login(DISCORD_TOKEN);
