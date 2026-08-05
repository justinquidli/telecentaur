/**
 * TeleCentaur — Claude-powered Telegram bot with Quidli Connect integration
 *
 * Features:
 * - Claude assistant with per-chat conversation history
 * - Multi-LLM: Claude, Gemini, OpenAI, Minds AI (per-chat switching)
 * - Quidli Connect API: lookup wallets, send tokens, reputation scores
 * - Per-user Quidli API keys: /connect <key> to use your own Smart Send wallet
 * - Scheduled & conditional drops (survive restarts via SQLite)
 * - Channel watchers: drop tokens to whoever types a trigger phrase first
 * - Minds AI handoff: Mind plans, Claude executes on confirmation
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createMindsClient, isReplyHistoryRow } from '@animocabrands/minds-client-lib';
import { createWalletClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { Telegraf } from 'telegraf';
import { message as messageFilter } from 'telegraf/filters';

// ─── Config ───────────────────────────────────────────────────────────────────

const {
  TELEGRAM_TOKEN,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-6',
  TELEGRAM_ALLOWED_USERS = '',   // Comma-separated Telegram user IDs allowed to use the bot
  SYSTEM_PROMPT: SYSTEM_PROMPT_OVERRIDE,
  BOT_WALLET_PRIVATE_KEY,
  BOT_WALLET_ADDRESS,
  QUIDLI_API_KEY,
  MASTER_ENCRYPTION_KEY,
  BOT_OWNER_ID,                  // Telegram user ID of the bot owner
  BRAVE_SEARCH_API_KEY,
  DEFAULT_LLM_PROVIDER = 'anthropic',
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.0-flash',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o',
  NOUS_API_KEY,                  // Nous Portal API key — from portal.nousresearch.com (API keys)
  NOUS_MODEL = 'Hermes-4-405B',  // or Hermes-4-70B — see portal.nousresearch.com/info for the full catalog
  REQUIRE_USER_LLM_KEY = 'false', // Set to 'true' to require users to bring their own LLM key
} = process.env;

// Nous Portal is OpenAI-compatible — reuses runOpenAILoop with a custom baseURL,
// same pattern as OpenRouter. Note: Nous's own docs say Hermes 4 isn't tuned for
// rapid-fire tool-calling loops (it's a chat/reasoning model) — wired in anyway
// per explicit request, so tool-call behavior may be less reliable than Claude/GPT/Gemini.
const NOUS_API_BASE_URL = 'https://inference-api.nousresearch.com/v1';

const REQUIRE_USER_LLM = REQUIRE_USER_LLM_KEY === 'true';

if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN is required');
if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
if (!BOT_WALLET_PRIVATE_KEY && !QUIDLI_API_KEY) {
  throw new Error('Either BOT_WALLET_PRIVATE_KEY or QUIDLI_API_KEY is required');
}

const ALLOWED_USERS = new Set(
  TELEGRAM_ALLOWED_USERS.split(',').map((s) => s.trim()).filter(Boolean)
);

const TG_MSG_LIMIT = 4000;
const EDIT_THROTTLE_MS = 1000; // Telegram rate limits are stricter than Discord
const QUIDLI_BASE_URL = 'https://api.connect.quid.li';

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = SYSTEM_PROMPT_OVERRIDE || `
You are TeleCentaur, a Telegram bot that sends crypto tokens to people using Quidli Connect. Your job is to EXECUTE — not explain, not ask for confirmation, not hedge. When someone asks you to do something, do it.

## Core philosophy
- Bias toward action. If you have enough info to act, act.
- Never ask "are you sure?" or "shall I proceed?" — if they asked, they're sure.
- Only ask the user for more info after you've exhausted all tool options.
- Be concise. One sentence for success, one sentence for failure.

## Sending tokens (quidli_drop)
- ALWAYS call quidli_lookup for every recipient FIRST, before calling quidli_drop.
- Email, phone, Twitter/X, and Farcaster recipients: quidli_lookup auto-generates a wallet for them even if they've never used Quidli before — it works for ANY real, existing account on these platforms, not just ones already linked to Quidli. The first call often returns status "processing" — call quidli_lookup again with the same payload (wait ~2s between tries, up to ~10 tries) until it returns "completed". This is expected and means a wallet is being created; do not give up early.
- Telegram recipients are different: Telegram's platform does not allow looking up an arbitrary @username unless that person has already interacted with a bot, or Quidli already has their numeric Telegram ID some other way. This means a raw Telegram @username with no prior bot interaction will fail immediately (status "completed" with them in "failed") even if it's a real, famous account — this is NOT something retrying will fix.
- For Telegram usernames specifically: ALWAYS call resolve_telegram_username FIRST before quidli_lookup/quidli_drop. It checks every chat this bot has seen them post in and returns their numeric ID if found — use that ID (not the username) for quidli_lookup and quidli_drop.
- If resolve_telegram_username finds nothing AND quidli_lookup/quidli_drop confirms the username can't be resolved: do NOT just tell the user to wait around. Call create_pending_claim with the recipient's username and the drop details instead. This returns a one-tap claim link. If you're in a group chat, the tool automatically posts the link directly, tagging the recipient — just tell the requester it's done, no need to forward anything. If you're in a DM, the bot has no way to reach the recipient directly, so tell the requester to forward the link themselves. Either way, once the recipient taps it, their wallet resolves and the drop executes automatically — no further action needed from anyone after that tap. Always prefer offering this claim link over saying "ask them to connect" or "ask them to message me" — it's faster and requires only one tap from the recipient.
- USDC on Base: chainId=8453, tokenContract=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 1 USDC = 1000000 amountInWeiPerRecipient (6 decimals).
- Always generate a fresh UUID for idempotencyKey.
- After success, always show the basescan URL: https://basescan.org/tx/<transferHash>
- If create_pending_claim also fails (no Quidli key connected), tell the user exactly that — ask if they have the person's numeric Telegram ID, or offer to send via email/phone/Twitter/Farcaster instead if available, or have the person connect at https://connect.quid.li (the ONLY correct URL — never invent or guess a different domain).
- Use EXACTLY one of "id" or "username" per recipient, never both.

## Looking up wallets (quidli_lookup)
Call quidli_lookup whenever the user asks for a wallet address, AND always before every quidli_drop (see above). For email/phone/Twitter/Farcaster, keep retrying while status is "processing" — it's actively generating a wallet, and will succeed even for people who've never used Quidli. For Telegram usernames, an immediate "completed" + "failed" response is final unless you have their numeric ID instead.

Supported identity types: discord, farcaster, twitter, telegram, email, github, linkedin, phone.

When a lookup fails, work through ALL available identifiers before giving up:
1. If a Telegram username is mentioned, try { type: "telegram", username: "<handle>" }
2. If a Twitter/X handle is mentioned, try { type: "twitter", username: "<handle>" }
3. If a Farcaster handle is mentioned, try { type: "farcaster", username: "<handle>" }
4. If an email is mentioned, try { type: "email", id: "<email>" }
5. If a Discord ID/username is known, try { type: "discord", id: "<id>" }
Only after exhausting all available identifiers, tell the user the person isn't in the Quidli registry yet.

## Looking up linked accounts (quidli_exposed)
Use quidli_exposed when someone asks what accounts a person has linked, or when you only have a username and need a numeric ID. It returns all platforms linked to that identity (email, wallet, smart_wallet, telegram, discord, etc.).
- If you have a Telegram @username but no numeric ID, call quidli_exposed with { type: "telegram", username: "<handle>" } to get their numeric ID, then use that for drops.

## Identity summary ("tell me about myself", "who am I?")
When someone asks about themselves — "tell me about myself", "who am I?", "what do you know about me?", "summarize my profile", "based on my socials" — do ALL of the following:
1. Call quidli_exposed with their Telegram ID (from the message context) to get all linked accounts
2. Call quidli_score with their Telegram ID to get their web3 reputation scores
3. For each professional/social platform in the exposed results (GitHub, LinkedIn, Twitter, Farcaster), call web_search to look up their public profile — find their employer, job title, notable projects, bio, or anything publicly known about them
Then synthesize everything into a warm, conversational paragraph: who they are professionally, what they build or work on, their on-chain presence and wallet addresses, and their reputation standing. Make it feel like a smart introduction, not a data dump. If LinkedIn or GitHub is linked, lean into those for professional context.

## Resolving Telegram mentions
Every message includes context like: "@username (Telegram ID: 123456789)". Always extract and use the Telegram ID when available — it's more reliable than usernames. If only a username is available, use quidli_exposed to resolve it first.

## Checking reputation (quidli_score)
Use quidli_score when asked about trust, reputation, or scores. Pass the most specific identity available.

## Web search (web_search)
Use web_search for any real-world facts: prices, scores, event results, news. Always search before answering factual questions about the world.

## Tool honesty — CRITICAL
NEVER claim a drop, conditional drop, watcher, or any action was completed unless you have an actual tool result in your context confirming it. This means:
- Do NOT write "Done!", "That's set!", or report a jobId unless you received it from a real tool response.
- Do NOT fabricate jobIds, transaction hashes, wallet addresses, or any other IDs.
- If you described doing something but have no tool result to back it up, say so immediately and call the tool for real.
- After any scheduling action, always quote the actual jobId from the tool response in your confirmation.

## Scheduling drops (schedule_drop)
Use schedule_drop when asked to send tokens at a future time.

## Conditional drops (conditional_drop)
Use conditional_drop when a drop depends on a real-world outcome ("if X wins", "if BTC hits $100k").
ALWAYS use web_search first to find the event's scheduled end time in UTC. Pass that time as checkAt (ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z") with a 30-minute buffer after the expected end. Never guess — search for the exact UTC time.

## Sending to everyone in a group (telegram_get_chat_members)
When someone says "send to everyone", "send to all members", "send to the whole group", or similar, call telegram_get_chat_members first to get the list of known chat members, then pass all returned members as recipients (using their telegramId with { type: "telegram", id: "<telegramId>" }). Exclude the requester from the recipient list (already done by the tool). If the list is empty, tell the user no other members have been seen in this chat yet.

## Channel watchers (create_watcher)
Use create_watcher when asked to send tokens to whoever types a specific phrase. The watcher fires automatically when triggered.

## Cancelling / rescheduling
Use cancel_scheduled_drop or reschedule_drop for scheduled drops. Use cancel_watcher for watchers. Use list_scheduled_drops / list_watchers to show what's pending.

## Tool retry behavior
If a tool call returns an error or empty result:
1. Analyze what went wrong.
2. Try a different approach (different identity type, different parameters).
3. Only report failure to the user after at least 2 attempts.

## Response format
- Success: state what you did + basescan URL if applicable. One or two sentences max.
- Failure: state what you tried and what the user can do next. No raw JSON, no stack traces.
- Never show internal error messages verbatim to the user.
- Do NOT use Markdown formatting — Telegram renders plain text by default.
`.trim();

// ─── Encryption helpers ───────────────────────────────────────────────────────

const encKey = MASTER_ENCRYPTION_KEY ? Buffer.from(MASTER_ENCRYPTION_KEY, 'hex') : null;

function encrypt(plaintext) {
  if (!encKey) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  if (!encKey) return stored;
  // If not in iv:tag:data format, it was stored before encryption was enabled — return as-is
  const parts = stored.split(':');
  if (parts.length !== 3) return stored;
  try {
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
  } catch {
    return stored;
  }
}

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new DatabaseSync('./users.db');
db.exec(`CREATE TABLE IF NOT EXISTS user_keys (
  telegram_id   TEXT PRIMARY KEY,
  api_key       TEXT NOT NULL DEFAULT '',
  minds_alias   TEXT,
  minds_api_key TEXT,
  minds_name    TEXT,
  created_at    INTEGER DEFAULT (unixepoch())
)`);
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_alias TEXT`); } catch { }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_api_key TEXT`); } catch { }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_name TEXT`); } catch { }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_mind_id TEXT`); } catch { }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN minds_alias_created_at INTEGER`); } catch { }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN llm_provider TEXT`); } catch { }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN llm_api_key TEXT`); } catch { }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN llm_model TEXT`); } catch { }

// Per-provider LLM keys — a user can store anthropic, gemini, openai, and openrouter keys side by side
db.exec(`CREATE TABLE IF NOT EXISTS user_llm_keys (
  user_id  TEXT NOT NULL,
  provider TEXT NOT NULL,
  api_key  TEXT NOT NULL,
  model    TEXT,
  PRIMARY KEY (user_id, provider)
)`);
// One-time migration from the legacy single-key columns (idempotent)
db.exec(`INSERT OR IGNORE INTO user_llm_keys (user_id, provider, api_key, model)
  SELECT telegram_id, llm_provider, llm_api_key, llm_model FROM user_keys
  WHERE llm_provider IS NOT NULL AND llm_api_key IS NOT NULL`);

db.exec(`CREATE TABLE IF NOT EXISTS scheduled_drops (
  id         TEXT PRIMARY KEY,
  sender_id  TEXT NOT NULL,
  chat_id    TEXT,
  drop_input TEXT NOT NULL,
  execute_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  executed   INTEGER DEFAULT 0
)`);
try { db.exec(`ALTER TABLE scheduled_drops ADD COLUMN chat_id TEXT`); } catch { }
// Pending claims — for Telegram recipients that can't be resolved by username.
// The sender gets a shareable t.me deep link; when the recipient clicks it and
// starts the bot, we get their numeric ID and execute the drop immediately.
// Nothing is moved on-chain until claimed, so an expired claim needs no refund.
db.exec(`CREATE TABLE IF NOT EXISTS pending_claims (
  id           TEXT PRIMARY KEY,
  sender_id    TEXT NOT NULL,
  chat_id      TEXT,
  recipient_username TEXT NOT NULL,
  drop_input   TEXT NOT NULL,
  created_at   INTEGER DEFAULT (unixepoch()),
  expires_at   INTEGER NOT NULL,
  claimed      INTEGER DEFAULT 0,
  expired      INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS watchers (
  id             TEXT PRIMARY KEY,
  sender_id      TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  trigger_phrase TEXT NOT NULL,
  drop_input     TEXT NOT NULL,
  max_winners    INTEGER DEFAULT 1,
  winner_count   INTEGER DEFAULT 0,
  winner_ids     TEXT DEFAULT '[]',
  created_at     INTEGER DEFAULT (unixepoch()),
  fired          INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS chat_settings (
  context_id TEXT PRIMARY KEY,
  provider   TEXT NOT NULL DEFAULT 'anthropic',
  model      TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
)`);
// Chat-level model override (e.g. "switch to fable" / "switch to kimi") — for upgrades
try { db.exec(`ALTER TABLE chat_settings ADD COLUMN model TEXT`); } catch { }
db.exec(`CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  username   TEXT,
  first_seen INTEGER DEFAULT (unixepoch()),
  last_seen  INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, user_id)
)`);

function getUserApiKey(telegramId) {
  const row = db.prepare('SELECT api_key FROM user_keys WHERE telegram_id = ?').get(String(telegramId));
  if (!row?.api_key) return null;
  return decrypt(row.api_key);
}

function setUserApiKey(telegramId, apiKey) {
  db.prepare(`INSERT INTO user_keys (telegram_id, api_key) VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET api_key = excluded.api_key`)
    .run(String(telegramId), encrypt(apiKey));
}

function deleteUserApiKey(telegramId) {
  db.prepare('UPDATE user_keys SET api_key = \'\' WHERE telegram_id = ?').run(String(telegramId));
}

function getUserMindsCredentials(telegramId) {
  const row = db.prepare('SELECT minds_alias, minds_api_key, minds_name, minds_mind_id, minds_alias_created_at FROM user_keys WHERE telegram_id = ?').get(String(telegramId));
  if (!row?.minds_alias || !row?.minds_api_key) return null;
  return {
    alias: row.minds_alias,
    apiKey: decrypt(row.minds_api_key),
    name: row.minds_name ?? 'Minds',
    mindId: row.minds_mind_id ?? null,
    aliasCreatedAt: row.minds_alias_created_at ?? null,
  };
}

function setUserMindsCredentials(telegramId, apiKey, alias, mindName, mindId) {
  db.prepare(`INSERT INTO user_keys (telegram_id, minds_alias, minds_api_key, minds_name, minds_mind_id, minds_alias_created_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(telegram_id) DO UPDATE SET
      minds_alias = excluded.minds_alias,
      minds_api_key = excluded.minds_api_key,
      minds_name = excluded.minds_name,
      minds_mind_id = excluded.minds_mind_id,
      minds_alias_created_at = excluded.minds_alias_created_at`)
    .run(String(telegramId), alias, encrypt(apiKey), mindName ?? null, mindId ?? null);
}

function deleteUserMindsCredentials(telegramId) {
  db.prepare('UPDATE user_keys SET minds_alias = NULL, minds_api_key = NULL, minds_name = NULL, minds_mind_id = NULL, minds_alias_created_at = NULL WHERE telegram_id = ?').run(String(telegramId));
}

function getUserLlmKeyFor(telegramId, provider) {
  const row = db.prepare('SELECT api_key, model FROM user_llm_keys WHERE user_id = ? AND provider = ?').get(String(telegramId), provider);
  if (!row?.api_key) return null;
  return { provider, apiKey: decrypt(row.api_key), model: row.model ?? null };
}

function hasAnyUserLlmKey(telegramId) {
  return !!db.prepare('SELECT 1 FROM user_llm_keys WHERE user_id = ? LIMIT 1').get(String(telegramId));
}

function setUserLlmKey(telegramId, provider, apiKey, model) {
  db.prepare(`INSERT INTO user_llm_keys (user_id, provider, api_key, model)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET api_key = excluded.api_key, model = COALESCE(excluded.model, user_llm_keys.model)`)
    .run(String(telegramId), provider, encrypt(apiKey), model ?? null);
}

function setUserLlmModel(telegramId, provider, model) {
  db.prepare('UPDATE user_llm_keys SET model = ? WHERE user_id = ? AND provider = ?').run(model, String(telegramId), provider);
}

function deleteUserLlmKey(telegramId, provider) {
  if (provider) {
    db.prepare('DELETE FROM user_llm_keys WHERE user_id = ? AND provider = ?').run(String(telegramId), provider);
  } else {
    db.prepare('DELETE FROM user_llm_keys WHERE user_id = ?').run(String(telegramId));
  }
  // Clear legacy columns so the migration doesn't resurrect removed keys
  db.prepare('UPDATE user_keys SET llm_provider = NULL, llm_api_key = NULL, llm_model = NULL WHERE telegram_id = ?').run(String(telegramId));
}

function recordChatMember(chatId, userId, username) {
  db.prepare(`INSERT INTO chat_members (chat_id, user_id, username, last_seen)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username, last_seen = unixepoch()`)
    .run(String(chatId), String(userId), username ?? null);
}

function getChatMembers(chatId) {
  return db.prepare('SELECT user_id, username FROM chat_members WHERE chat_id = ?').all(String(chatId));
}

// Search every chat the bot has ever seen (not just the current one) for a username
// this lets us resolve a Telegram @handle to a numeric ID even if they've never
// DMed the bot directly, as long as they've posted in any shared group.
function findUserIdByUsername(username) {
  const clean = username.replace(/^@/, '').toLowerCase();
  const row = db.prepare(
    'SELECT user_id, username FROM chat_members WHERE LOWER(username) = ? ORDER BY last_seen DESC LIMIT 1'
  ).get(clean);
  return row ? row.user_id : null;
}

// ─── Provider switching ───────────────────────────────────────────────────────

function getChannelProvider(contextId) {
  const row = db.prepare('SELECT provider FROM chat_settings WHERE context_id = ?').get(String(contextId));
  return row?.provider ?? DEFAULT_LLM_PROVIDER;
}

function getChannelModel(contextId) {
  const row = db.prepare('SELECT model FROM chat_settings WHERE context_id = ?').get(String(contextId));
  return row?.model ?? null;
}

// Switching providers always resets the model (null unless a specific model was named)
function setChannelProvider(contextId, provider, model = null) {
  db.prepare(`INSERT INTO chat_settings (context_id, provider, model, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(context_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = unixepoch()`)
    .run(String(contextId), provider, model);
}

function detectProviderSwitch(text) {
  const lower = text.toLowerCase();
  if (/(switch|change|use|swap)\s+(to\s+)?(gemini|google)/.test(lower)) return 'gemini';
  if (/(switch|change|use|swap)\s+(to\s+)?(openai|gpt|chatgpt|open\s*ai)/.test(lower)) return 'openai';
  if (/(switch|change|use|swap)\s+(to\s+)?(claude|anthropic|fable|opus|haiku|sonnet)/.test(lower)) return 'anthropic';
  if (/(switch|change|use|swap)\s+(to\s+)?(openrouter|open\s*router|kimi|llama|mistral|deepseek)/.test(lower)) return 'openrouter';
  if (/(switch|change|use|swap)\s+(to\s+)?(hermes|nous)/.test(lower)) return 'hermes';
  if (/\bgemini\s+mode\b/.test(lower)) return 'gemini';
  if (/\bopenai\s+mode\b/.test(lower)) return 'openai';
  if (/\b(claude|fable|opus|haiku|sonnet)\s+mode\b/.test(lower)) return 'anthropic';
  if (/\b(openrouter|kimi|llama|mistral|deepseek)\s+mode\b/.test(lower)) return 'openrouter';
  if (/\b(hermes|nous)\s+mode\b/.test(lower)) return 'hermes';
  if (/(switch|change|use|swap)\s+(to\s+)?minds/.test(lower)) return 'minds';
  if (/\bminds\s+mode\b/.test(lower)) return 'minds';
  return null;
}

// Map friendly model names to OpenRouter slugs. Named model in a switch phrase
// (e.g. "switch to kimi") sets the user's OpenRouter model too.
const OPENROUTER_MODEL_ALIASES = {
  kimi: 'moonshotai/kimi-k2.6',
  llama: 'meta-llama/llama-3.3-70b-instruct',
  deepseek: 'deepseek/deepseek-chat',
  mistral: 'mistralai/mistral-large',
};

// Claude via OpenRouter for BYOLLM users who only have an OpenRouter key
const OPENROUTER_CLAUDE_SLUG = 'anthropic/claude-sonnet-4.6';

// Named Claude models for "switch to fable" etc.
const ANTHROPIC_MODEL_ALIASES = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};

function detectOpenRouterModel(text) {
  const lower = text.toLowerCase();
  for (const [alias, slug] of Object.entries(OPENROUTER_MODEL_ALIASES)) {
    if (lower.includes(alias)) return slug;
  }
  return null;
}

function detectAnthropicModel(text) {
  const lower = text.toLowerCase();
  for (const [alias, slug] of Object.entries(ANTHROPIC_MODEL_ALIASES)) {
    if (lower.includes(alias)) return slug;
  }
  return null;
}

// ─── Conversation history ─────────────────────────────────────────────────────

const anthropicHistories = new Map();
const geminiHistories    = new Map();
const openaiHistories    = new Map();
const MAX_HISTORY = 40;

function getAnthropicHistory(contextId) {
  if (!anthropicHistories.has(contextId)) anthropicHistories.set(contextId, []);
  return anthropicHistories.get(contextId);
}
function getGeminiHistory(contextId) {
  if (!geminiHistories.has(contextId)) geminiHistories.set(contextId, []);
  return geminiHistories.get(contextId);
}
function getOpenAIHistory(contextId) {
  if (!openaiHistories.has(contextId)) openaiHistories.set(contextId, []);
  return openaiHistories.get(contextId);
}


function stripHtml(text) {
  return text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

function looksLikePendingAction(text) {
  const hasWallet = /0x[0-9a-fA-F]{40}/i.test(text);
  const hasActionLanguage = /\b(confirm|fire it?|proceed|approve|go ahead|ready to|shall i|execute|let me know|either path|two paths?|two options?|option \d|queued|send is|drop is)\b/i.test(text);
  const hasAmount = /\b(usdc|usdt|wei|eth)\b/i.test(text);
  return hasWallet && (hasActionLanguage || hasAmount);
}

function isPositiveConfirmation(text) {
  const t = text.trim().toLowerCase();
  if (t.length > 120) return false;
  return /\b(yes|yep|yup|yeah|go|do it|fire it|fire|confirm(ed)?|sure|ok(ay)?|proceed|send it|send now|execute|approved?|absolutely|👍|✅|correct|affirmative|let'?s go|go ahead|sounds good|looks good|perfect|please do|go for it|make it so|just send|send it now|do it now|just do it)\b/i.test(t);
}

// ─── Web search ───────────────────────────────────────────────────────────────

async function braveSearch(query) {
  if (!BRAVE_SEARCH_API_KEY) throw new Error('BRAVE_SEARCH_API_KEY is not set');
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_SEARCH_API_KEY,
      },
    });
    if (!res.ok) throw new Error(`Brave Search error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, description: r.description }));
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Wallet (x402) ───────────────────────────────────────────────────────────

let walletClient;
if (BOT_WALLET_PRIVATE_KEY) {
  const account = privateKeyToAccount(BOT_WALLET_PRIVATE_KEY);
  walletClient = createWalletClient({ account, chain: base, transport: http() });
}

// ─── Quidli API ───────────────────────────────────────────────────────────────

async function quidliFetch(path, options = {}, apiKey = QUIDLI_API_KEY) {
  const url = `${QUIDLI_BASE_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    ...(options.headers ?? {}),
  };
  const res = await fetch(url, { ...options, headers });

  if (res.status === 402 && walletClient && !apiKey) {
    const paymentDetails = await res.json();
    const payment = paymentDetails.accepts?.[0];
    if (!payment) throw new Error('No payment method offered by x402 response');
    const { scheme, network, asset, amount, payTo } = payment;
    if (scheme !== 'exact' || asset?.symbol !== 'USDC') {
      throw new Error(`Unsupported x402 payment scheme: ${scheme} / ${asset?.symbol}`);
    }
    const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const txHash = await walletClient.sendTransaction({
      to: USDC_BASE,
      data: encodeFunctionData({
        abi: [{ name: 'transfer', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
        functionName: 'transfer',
        args: [payTo, BigInt(amount)],
      }),
    });
    const retryRes = await fetch(url, { ...options, headers: { ...headers, 'X-Payment': JSON.stringify({ txHash, network, scheme }) } });
    if (!retryRes.ok) throw new Error(`Quidli error after payment ${retryRes.status}: ${await retryRes.text()}`);
    return retryRes;
  }

  if (!res.ok) throw new Error(`Quidli error ${res.status}: ${await res.text()}`);
  return res;
}

async function quidliLookup(recipients) {
  const res = await quidliFetch('/lookup', { method: 'POST', body: JSON.stringify({ recipients }) });
  const data = await res.json();
  if (data.status === 'completed') {
    console.log('[quidli_lookup] completed response:', JSON.stringify(data));
    return data.results;
  }

  const pendingId = data.pendingRequestId ?? data.requestId ?? data.id ?? data.jobId ?? null;
  if (data.status === 'processing') {
    if (!pendingId) {
      console.error('[quidli_lookup] processing status but no recognizable pending-id field. Raw response:', JSON.stringify(data));
    } else {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const followUp = await quidliFetch(`/lookup/follow-up/${pendingId}`);
        const followData = await followUp.json();
        if (followData.status === 'completed') {
          const retry = await quidliFetch('/lookup', { method: 'POST', body: JSON.stringify({ recipients }) });
          const retryData = await retry.json();
          return retryData.results ?? [];
        }
      }
      throw new Error('Lookup timed out after processing');
    }
  }
  console.error('[quidli_lookup] unexpected response:', JSON.stringify(data));
  throw new Error(`Unexpected lookup status: ${data.status}`);
}

async function quidliDrop({ recipients, amountInWeiPerRecipient, chainId = 8453, tokenContract }, apiKey = QUIDLI_API_KEY) {
  recipients = recipients.map(({ type, id, username }) => {
    if (id) return { type, id };
    if (username) return { type, username };
    return { type };
  });
  if (!apiKey) throw new Error('No Quidli API key available. DM me /connect <your-api-key> to link your account.');
  const idempotencyKey = crypto.randomUUID();
  const res = await quidliFetch('/drop', {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey, chainId, tokenContract, amountInWeiPerRecipient, recipients }),
  }, apiKey);
  return res.json();
}

async function quidliScore({ users, filter }) {
  const body = { users };
  if (filter) body.filter = filter;
  const res = await quidliFetch('/scores', { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

async function quidliExposed(recipient) {
  const res = await quidliFetch('/lookup/exposed', { method: 'POST', body: JSON.stringify({ recipient }) });
  return res.json();
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const RECIPIENT_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['discord', 'email', 'phone', 'twitter', 'telegram', 'farcaster', 'github', 'linkedin'],
      description: 'The social platform type',
    },
    id: { type: 'string', description: 'Numeric user ID on that platform. Use EITHER id OR username, never both.' },
    username: { type: 'string', description: 'Handle/username. Use EITHER id OR username, never both.' },
  },
  required: ['type'],
};

const tools = [
  {
    name: 'web_search',
    description: 'Search the web for current information — prices, news, scores, anything real-time.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'quidli_lookup',
    description: 'Look up wallet addresses for people by their social identity (Telegram, Twitter, email, Farcaster, GitHub, Discord, LinkedIn, phone). Use when someone asks for a wallet address.',
    input_schema: {
      type: 'object',
      properties: { recipients: { type: 'array', items: RECIPIENT_SCHEMA } },
      required: ['recipients'],
    },
  },
  {
    name: 'quidli_drop',
    description: 'Send tokens to one or more people by their social identity using Quidli Smart Send. Use whenever someone asks to send, tip, or drop tokens/USDC.',
    input_schema: {
      type: 'object',
      properties: {
        recipients: { type: 'array', items: RECIPIENT_SCHEMA },
        amountInWeiPerRecipient: { type: 'string', description: 'Amount in wei per recipient. E.g. "1000000" for 1 USDC (6 decimals).' },
        tokenContract: { type: 'string', description: 'Token contract address. USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        chainId: { type: 'number', description: 'Chain ID. Base = 8453 (default).' },
      },
      required: ['recipients', 'amountInWeiPerRecipient', 'tokenContract'],
    },
  },
  {
    name: 'quidli_score',
    description: 'Get the web3 reputation/social score for a user. Accepts any social identity.',
    input_schema: {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['discord', 'email', 'phone', 'twitter', 'telegram', 'farcaster', 'github', 'linkedin'] },
              id: { type: 'string' },
            },
            required: ['type'],
          },
        },
        filter: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['quidli_score', 'lens_score', 'neynar_score', 'ethos_twitter_reputation', 'ethos_wallet_reputation'] },
            minScore: { type: 'number' },
          },
        },
      },
      required: ['users'],
    },
  },
  {
    name: 'schedule_drop',
    description: 'Schedule a token drop to execute at a future time. Use when someone says "send X in N minutes/hours".',
    input_schema: {
      type: 'object',
      properties: {
        delayMinutes: { type: 'number', description: 'How many minutes from now to execute the drop.' },
        recipients: { type: 'array', items: RECIPIENT_SCHEMA },
        amountInWeiPerRecipient: { type: 'string' },
        tokenContract: { type: 'string' },
        chainId: { type: 'number', description: 'Chain ID. Base = 8453 (default).' },
      },
      required: ['delayMinutes', 'recipients', 'amountInWeiPerRecipient', 'tokenContract'],
    },
  },
  {
    name: 'list_scheduled_drops',
    description: 'List all pending scheduled drops for the current user.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reschedule_drop',
    description:
      'Update the check time of a pending scheduled or conditional drop. ' +
      'ALWAYS use web_search first to find the event\'s scheduled end time in UTC. Pass that time as newCheckAt (ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z") with a 30-minute buffer after the expected end. Never guess — search for the exact UTC time. ' +
      'Get the job ID from list_scheduled_drops if needed.',
    input_schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job ID to reschedule.' },
        newCheckAt: { type: 'string', description: 'New absolute UTC time to check/execute, as an ISO 8601 string e.g. "2026-06-27T22:30:00Z".' },
      },
      required: ['jobId', 'newCheckAt'],
    },
  },
  {
    name: 'cancel_scheduled_drop',
    description: 'Cancel a pending scheduled drop by its job ID.',
    input_schema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'conditional_drop',
    description: 'Schedule a token drop that only executes if a real-world condition is true at check time. ALWAYS use web_search first to find the event\'s end time.',
    input_schema: {
      type: 'object',
      properties: {
        condition: { type: 'string', description: 'The condition as a clear yes/no question.' },
        checkAt: { type: 'string', description: 'ISO 8601 UTC timestamp for when to evaluate the condition, e.g. "2026-06-27T22:30:00Z". Use web_search to find the event\'s scheduled end time in UTC, then add a 30-minute buffer.' },
        recipients: { type: 'array', items: RECIPIENT_SCHEMA },
        amountInWeiPerRecipient: { type: 'string' },
        tokenContract: { type: 'string' },
        chainId: { type: 'number' },
      },
      required: ['condition', 'checkAt', 'recipients', 'amountInWeiPerRecipient', 'tokenContract'],
    },
  },
  {
    name: 'create_watcher',
    description: 'Watch a Telegram chat for a trigger phrase and automatically send tokens to whoever types it first.',
    input_schema: {
      type: 'object',
      properties: {
        triggerPhrase: { type: 'string', description: 'The phrase to watch for (case-insensitive).' },
        chatId: { type: 'string', description: 'Chat ID to watch. Omit to use the current chat.' },
        maxWinners: { type: 'number', description: 'How many people can win. Default 1.' },
        amountInWeiPerRecipient: { type: 'string' },
        tokenContract: { type: 'string' },
        chainId: { type: 'number' },
      },
      required: ['triggerPhrase', 'amountInWeiPerRecipient', 'tokenContract'],
    },
  },
  {
    name: 'list_watchers',
    description: 'List all active channel watchers for the current user.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_watcher',
    description: 'Cancel an active watcher by its ID.',
    input_schema: {
      type: 'object',
      properties: { watcherId: { type: 'string' } },
      required: ['watcherId'],
    },
  },
  {
    name: 'quidli_exposed',
    description: 'Look up all linked social accounts and wallets for a person. Use when someone asks "what accounts does X have?", "what\'s linked to this email/handle?", or when you need to resolve a Telegram username to a numeric ID before sending. Returns all platforms linked to that identity (email, wallet, smart_wallet, telegram, discord, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['discord', 'email', 'phone', 'twitter', 'telegram', 'farcaster', 'github', 'linkedin'],
            },
            id: { type: 'string', description: 'Numeric ID or email. Use EITHER id OR username.' },
            username: { type: 'string', description: 'Handle/username. Use EITHER id OR username.' },
          },
          required: ['type'],
        },
      },
      required: ['recipient'],
    },
  },
  {
    name: 'telegram_get_chat_members',
    description: 'Get all known members of the current Telegram group chat. Use this when someone asks to send tokens to "everyone", "all members", "the whole group", or similar. Returns a list of Telegram user IDs and usernames of people who have sent messages in this chat.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve_telegram_username',
    description: 'Resolve a Telegram @username to its numeric Telegram ID by checking every group chat this bot has ever seen them post in. ALWAYS try this BEFORE calling quidli_lookup/quidli_drop with a raw Telegram username, since Telegram itself does not let Quidli resolve arbitrary usernames — only numeric IDs work reliably. If this returns a numeric ID, use { type: "telegram", id: "<id>" } for quidli_lookup and quidli_drop instead of username. If it returns nothing, the bot has never seen that user active anywhere, and you should tell the requester to ask them to DM this bot directly (any message, even just "hi") — after they do, this will resolve them.',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'The Telegram @username to resolve, without or with the @ sign.' },
      },
      required: ['username'],
    },
  },
  {
    name: 'create_pending_claim',
    description: 'When a Telegram username cannot be resolved (resolve_telegram_username found nothing, and Quidli lookup fails), use this INSTEAD of giving up. It creates a one-time shareable link — send it to the requester and tell them to forward it to the recipient. As soon as the recipient clicks it and starts this bot (a single tap, no typing needed), their wallet resolves automatically and the drop executes immediately. The claim holds for 3 days; if unclaimed by then, it silently expires and no funds are ever moved (nothing to refund since nothing was sent).',
    input_schema: {
      type: 'object',
      properties: {
        recipientUsername: { type: 'string', description: 'The Telegram @username (without @) this claim is for — just for display in messages.' },
        amountInWeiPerRecipient: { type: 'string', description: 'Amount in wei, e.g. 1000000 for 1 USDC (6 decimals).' },
        tokenContract: { type: 'string', description: 'ERC-20 token contract address.' },
        chainId: { type: 'number', description: 'Chain ID, e.g. 8453 for Base.' },
      },
      required: ['recipientUsername', 'amountInWeiPerRecipient', 'tokenContract', 'chainId'],
    },
  },
];

// Tracks basescan URLs produced during a turn so they're always shown
const _pendingBasescanUrls = [];

// Some models (observed: Kimi K2.6 via OpenRouter) will occasionally narrate a
// fake "transaction sent" message with an invented tx hash instead of actually
// calling quidli_drop. Since this bot moves real money, never trust a model's
// own claim of a basescan link — only ever show one that came from a real
// quidliDrop() result this turn. Anything else gets stripped and flagged.
const BASESCAN_TX_RE = /https?:\/\/basescan\.org\/tx\/(0x[a-fA-F0-9]{64})/g;
function sanitizeUnverifiedTxClaims(text, realUrls) {
  const realHashes = new Set(
    realUrls.map((u) => u.match(/0x[a-fA-F0-9]{64}/)?.[0]?.toLowerCase()).filter(Boolean)
  );
  return text.replace(BASESCAN_TX_RE, (fullMatch, hash) => {
    if (realHashes.has(hash.toLowerCase())) return fullMatch;
    console.warn(`[safety] stripped unverified/fabricated tx link from model output: ${fullMatch}`);
    return '⚠️ [unverified transaction link removed — no matching transfer was actually recorded, this may not have really happened]';
  });
}

// ─── Tool runner ──────────────────────────────────────────────────────────────

async function runTool(name, input, { senderId, senderApiKey, currentChatId, isPrivateChat } = {}) {
  console.log(`[tool] ${name}`, JSON.stringify(input).slice(0, 120));

  if (name === 'web_search') {
    return JSON.stringify(await braveSearch(input.query), null, 2);
  }

  if (name === 'quidli_lookup') {
    return JSON.stringify(await quidliLookup(input.recipients), null, 2);
  }

  if (name === 'quidli_drop') {
    const isOwner = BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) {
      return JSON.stringify({ error: 'No Quidli API key connected. DM me /connect <your-api-key> to link your account.' });
    }
    const result = await quidliDrop(input, keyToUse);
    if (result.transferHash) {
      result.basescanUrl = `https://basescan.org/tx/${result.transferHash}`;
      _pendingBasescanUrls.push(result.basescanUrl);
    }
    console.log('[drop] result:', JSON.stringify(result, null, 2));
    return JSON.stringify(result, null, 2);
  }

  if (name === 'quidli_score') {
    return JSON.stringify(await quidliScore(input), null, 2);
  }

  if (name === 'quidli_exposed') {
    return JSON.stringify(await quidliExposed(input.recipient), null, 2);
  }

  if (name === 'schedule_drop') {
    const isOwner = BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) return JSON.stringify({ error: 'No Quidli API key connected. DM me /connect <your-api-key> to link your account.' });
    const { delayMinutes, ...dropInput } = input;
    const executeAt = Math.floor((Date.now() + delayMinutes * 60 * 1000) / 1000);
    const jobId = crypto.randomUUID();
    db.prepare('INSERT INTO scheduled_drops (id, sender_id, chat_id, drop_input, execute_at) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, String(senderId), String(currentChatId), JSON.stringify(dropInput), executeAt);
    scheduleDropJob(jobId, executeAt * 1000);
    return JSON.stringify({ success: true, jobId, scheduledFor: new Date(executeAt * 1000).toISOString() });
  }

  if (name === 'list_scheduled_drops') {
    const jobs = db.prepare('SELECT id, drop_input, execute_at FROM scheduled_drops WHERE sender_id = ? AND executed = 0 ORDER BY execute_at ASC').all(String(senderId));
    return JSON.stringify({ pending: jobs.map((j) => ({ jobId: j.id, scheduledFor: new Date(j.execute_at * 1000).toISOString(), drop: JSON.parse(j.drop_input) })) }, null, 2);
  }

  if (name === 'reschedule_drop') {
    const job = db.prepare('SELECT id, sender_id, drop_input FROM scheduled_drops WHERE id = ? AND executed = 0').get(input.jobId);
    if (!job) return JSON.stringify({ error: 'No pending drop found with that ID.' });
    if (job.sender_id !== String(senderId)) return JSON.stringify({ error: 'You can only reschedule your own drops.' });
    const checkAtMs = new Date(input.newCheckAt).getTime();
    if (isNaN(checkAtMs)) return JSON.stringify({ error: 'Invalid newCheckAt timestamp. Provide an ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z".' });
    const newExecuteAt = Math.floor(checkAtMs / 1000);
    db.prepare('UPDATE scheduled_drops SET execute_at = ? WHERE id = ?').run(newExecuteAt, input.jobId);
    const stored = JSON.parse(job.drop_input);
    const delay = Math.max(0, checkAtMs - Date.now());
    if (stored.type === 'conditional') {
      setTimeout(() => executeConditionalDrop(input.jobId), delay);
    } else {
      setTimeout(() => executeScheduledDrop(input.jobId), delay);
    }
    return JSON.stringify({ success: true, newCheckAt: new Date(newExecuteAt * 1000).toISOString() });
  }

  if (name === 'cancel_scheduled_drop') {
    const job = db.prepare('SELECT id, sender_id FROM scheduled_drops WHERE id = ? AND executed = 0').get(input.jobId);
    if (!job) return JSON.stringify({ error: 'No pending drop found with that ID.' });
    if (job.sender_id !== String(senderId)) return JSON.stringify({ error: 'You can only cancel your own scheduled drops.' });
    db.prepare('UPDATE scheduled_drops SET executed = 1 WHERE id = ?').run(input.jobId);
    return JSON.stringify({ success: true });
  }

  if (name === 'conditional_drop') {
    const isOwner = BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) return JSON.stringify({ error: 'No Quidli API key connected.' });
    const { condition, checkAt, ...dropParams } = input;
    const checkAtMs = new Date(checkAt).getTime();
    if (isNaN(checkAtMs)) return JSON.stringify({ error: 'Invalid checkAt timestamp. Provide an ISO 8601 UTC string, e.g. "2026-06-27T22:30:00Z".' });
    const executeAt = Math.floor(checkAtMs / 1000);
    const jobId = crypto.randomUUID();
    db.prepare('INSERT INTO scheduled_drops (id, sender_id, chat_id, drop_input, execute_at) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, String(senderId), String(currentChatId), JSON.stringify({ type: 'conditional', condition, dropParams }), executeAt);
    setTimeout(() => executeConditionalDrop(jobId), Math.max(0, checkAtMs - Date.now()));
    return JSON.stringify({ success: true, jobId, condition, checkAt: new Date(executeAt * 1000).toISOString() });
  }

  if (name === 'create_watcher') {
    const isOwner = BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) return JSON.stringify({ error: 'No Quidli API key connected.' });
    const watcherId = crypto.randomUUID();
    const dropInput = { amountInWeiPerRecipient: input.amountInWeiPerRecipient, tokenContract: input.tokenContract, chainId: input.chainId ?? 8453 };
    db.prepare('INSERT INTO watchers (id, sender_id, chat_id, trigger_phrase, drop_input, max_winners) VALUES (?, ?, ?, ?, ?, ?)')
      .run(watcherId, String(senderId), input.chatId ?? String(currentChatId), input.triggerPhrase, JSON.stringify(dropInput), input.maxWinners ?? 1);
    return JSON.stringify({ success: true, watcherId, message: `Watching for "${input.triggerPhrase}". First person to type it gets the drop.` });
  }

  if (name === 'list_watchers') {
    const watchers = db.prepare('SELECT id, trigger_phrase, chat_id, max_winners, winner_count FROM watchers WHERE sender_id = ? AND fired = 0').all(String(senderId));
    return JSON.stringify(watchers, null, 2);
  }

  if (name === 'cancel_watcher') {
    const watcher = db.prepare('SELECT id, sender_id FROM watchers WHERE id = ? AND fired = 0').get(input.watcherId);
    if (!watcher) return JSON.stringify({ error: 'No active watcher found with that ID.' });
    if (watcher.sender_id !== String(senderId)) return JSON.stringify({ error: 'You can only cancel your own watchers.' });
    db.prepare('UPDATE watchers SET fired = 1 WHERE id = ?').run(input.watcherId);
    return JSON.stringify({ success: true });
  }

  if (name === 'telegram_get_chat_members') {
    const members = getChatMembers(currentChatId);
    // Exclude the requester themselves
    const others = members.filter((m) => m.user_id !== String(senderId));
    return JSON.stringify({
      members: others.map((m) => ({ telegramId: m.user_id, username: m.username ?? null })),
      count: others.length,
      note: 'These are members who have sent messages in this chat. Use their telegramId with { type: "telegram", id: "<telegramId>" } for drops.',
    }, null, 2);
  }

  if (name === 'resolve_telegram_username') {
    const telegramId = findUserIdByUsername(input.username);
    if (telegramId) {
      return JSON.stringify({ found: true, telegramId, note: `Use { type: "telegram", id: "${telegramId}" } for quidli_lookup/quidli_drop.` });
    }
    return JSON.stringify({
      found: false,
      note: 'This bot has never seen that username active in any chat it\'s in. Ask the requester to have that person DM this bot directly (any message) — after that, resolve_telegram_username will find them.',
    });
  }

  if (name === 'create_pending_claim') {
    const isOwner = BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) {
      return JSON.stringify({ error: 'No Quidli API key connected. DM me /connect <your-api-key> to link your account.' });
    }
    const dropInput = {
      amountInWeiPerRecipient: input.amountInWeiPerRecipient,
      tokenContract: input.tokenContract,
      chainId: input.chainId,
    };
    const cleanUsername = input.recipientUsername.replace(/^@/, '');
    const claim = createPendingClaim(senderId, currentChatId, cleanUsername, dropInput);

    // In a group chat, post the link directly so the recipient sees it without
    // the sender needing to forward anything — the bot can't DM them directly
    // (no numeric ID yet), but it can post in a chat it's already in.
    let postedDirectly = false;
    if (!isPrivateChat) {
      try {
        await tg.telegram.sendMessage(currentChatId, `@${cleanUsername} — tap here to claim your tokens: ${claim.link}`);
        postedDirectly = true;
      } catch (err) {
        console.error('[claim] failed to post link in chat:', err.message);
      }
    }

    return JSON.stringify({
      success: true,
      claimLink: claim.link,
      expiresAt: new Date(claim.expiresAt * 1000).toISOString(),
      postedDirectlyInChat: postedDirectly,
      note: postedDirectly
        ? 'The claim link was already posted directly in this chat, tagging the recipient — no need to forward it yourself.'
        : 'This is a DM, so I can\'t reach the recipient directly. Share this link with them yourself — one tap and the drop executes automatically. Expires in 3 days unclaimed.',
    });
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ─── Scheduled drop executor ──────────────────────────────────────────────────

async function executeScheduledDrop(jobId) {
  const job = db.prepare('SELECT * FROM scheduled_drops WHERE id = ? AND executed = 0').get(jobId);
  if (!job) return;
  db.prepare('UPDATE scheduled_drops SET executed = 1 WHERE id = ?').run(jobId);

  const stored = JSON.parse(job.drop_input);
  const isOwner = BOT_OWNER_ID && job.sender_id === String(BOT_OWNER_ID);
  const senderApiKey = getUserApiKey(job.sender_id);
  const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);

  const notifyChat = job.chat_id ?? job.sender_id;
  try {
    if (!keyToUse) throw new Error('No API key available.');
    const result = await quidliDrop(stored, keyToUse);
    const recipientCount = stored.recipients?.length ?? 1;
    const msg = `✅ Scheduled drop executed! Sent to ${recipientCount} recipient${recipientCount !== 1 ? 's' : ''}.` +
      (result.transferHash ? `\nhttps://basescan.org/tx/${result.transferHash}` : '');
    await tg.telegram.sendMessage(notifyChat, msg).catch(() => {});
  } catch (err) {
    console.error(`[scheduled-drop] ${jobId} failed:`, err.message);
    await tg.telegram.sendMessage(notifyChat, `⚠️ Scheduled drop failed: ${err.message}`).catch(() => {});
  }
}

function scheduleDropJob(jobId, executeAt) {
  const delay = Math.max(0, executeAt - Date.now());
  setTimeout(() => executeScheduledDrop(jobId), delay);
}

async function executeConditionalDrop(jobId) {
  const job = db.prepare('SELECT * FROM scheduled_drops WHERE id = ? AND executed = 0').get(jobId);
  if (!job) return;
  db.prepare('UPDATE scheduled_drops SET executed = 1 WHERE id = ?').run(jobId);

  const stored = JSON.parse(job.drop_input);
  const { condition, dropParams } = stored;

  try {
    const evalNow = new Date();
    let evalMessages = [{
      role: 'user',
      content: `Evaluate this condition as true or false via web search.\nCurrent time: ${evalNow.toUTCString()}\nCondition: "${condition}"\nRespond ONLY with JSON: {"result": true} or {"result": false}`,
    }];
    const evalTools = [{ name: 'web_search', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
    let conditionMet = false;

    for (let i = 0; i < 5; i++) {
      const evalRes = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 1024, tools: evalTools, messages: evalMessages });
      if (evalRes.stop_reason === 'tool_use') {
        const toolBlocks = evalRes.content.filter((b) => b.type === 'tool_use');
        const toolResults = await Promise.all(toolBlocks.map(async (tb) => ({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(await braveSearch(tb.input.query)) })));
        evalMessages = [...evalMessages, { role: 'assistant', content: evalRes.content }, { role: 'user', content: toolResults }];
        continue;
      }
      const text = evalRes.content.find((b) => b.type === 'text')?.text ?? '';
      const match = text.match(/\{.*"result"\s*:\s*(true|false).*\}/s);
      if (match) conditionMet = match[1] === 'true';
      break;
    }

    // Post results to the original chat where it was set up, fall back to DM
    const notifyChat = job.chat_id ?? job.sender_id;

    if (!conditionMet) {
      await tg.telegram.sendMessage(notifyChat, `❌ Condition not met: "${condition}"\nDrop cancelled.`).catch(() => {});
      return;
    }

    const isOwner = BOT_OWNER_ID && job.sender_id === String(BOT_OWNER_ID);
    const senderApiKey = getUserApiKey(job.sender_id);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) throw new Error('No API key available.');

    const result = await quidliDrop(dropParams, keyToUse);
    const recipientCount = dropParams.recipients?.length ?? 1;
    await tg.telegram.sendMessage(notifyChat,
      `✅ Condition met: "${condition}"\nDrop executed to ${recipientCount} recipient${recipientCount !== 1 ? 's' : ''}.` +
      (result.transferHash ? `\nhttps://basescan.org/tx/${result.transferHash}` : '')
    ).catch(() => {});
  } catch (err) {
    console.error(`[conditional-drop] ${jobId} failed:`, err.message);
    const notifyChat = job.chat_id ?? job.sender_id;
    await tg.telegram.sendMessage(notifyChat, `⚠️ Conditional drop failed: ${err.message}`).catch(() => {});
  }
}

const CLAIM_HOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function createPendingClaim(senderId, chatId, recipientUsername, dropInput) {
  const id = crypto.randomUUID();
  const expiresAt = Math.floor((Date.now() + CLAIM_HOLD_MS) / 1000);
  db.prepare(`INSERT INTO pending_claims (id, sender_id, chat_id, recipient_username, drop_input, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, String(senderId), String(chatId), recipientUsername, JSON.stringify(dropInput), expiresAt);
  scheduleClaimExpiry(id, expiresAt * 1000);
  return { id, expiresAt, link: `https://t.me/${tg.botInfo?.username}?start=claim_${id}` };
}

function scheduleClaimExpiry(claimId, expiresAtMs) {
  const delay = Math.max(0, expiresAtMs - Date.now());
  setTimeout(() => expireClaimIfUnclaimed(claimId), delay);
}

function expireClaimIfUnclaimed(claimId) {
  const claim = db.prepare('SELECT * FROM pending_claims WHERE id = ? AND claimed = 0 AND expired = 0').get(claimId);
  if (!claim) return; // already claimed, or already expired
  db.prepare('UPDATE pending_claims SET expired = 1 WHERE id = ?').run(claimId);
  const notifyChat = claim.chat_id ?? claim.sender_id;
  tg.telegram.sendMessage(notifyChat,
    `⌛ The claim link for @${claim.recipient_username} expired unclaimed after 3 days. No funds were sent — nothing to refund.`
  ).catch(() => {});
  console.log(`[claim] ${claimId} expired unclaimed (@${claim.recipient_username})`);
}

async function executeClaimedDrop(claimId, claimerTelegramId, claimerUsername) {
  const claim = db.prepare('SELECT * FROM pending_claims WHERE id = ? AND claimed = 0 AND expired = 0').get(claimId);
  if (!claim) return { ok: false, reason: 'This claim link is invalid, already used, or has expired.' };

  // Verify the person clicking is actually the intended recipient, not whoever got the link first
  const claimerHandle = (claimerUsername ?? '').replace(/^@/, '').toLowerCase();
  if (claimerHandle !== claim.recipient_username.toLowerCase()) {
    console.warn(`[claim] ${claimId} rejected — meant for @${claim.recipient_username}, clicked by @${claimerUsername ?? '(no username)'}`);
    return {
      ok: false,
      reason: `This claim is for @${claim.recipient_username}, not you. If that's your username and you're seeing this by mistake, make sure your Telegram username in Settings is set to exactly @${claim.recipient_username} (case doesn't matter) and try the link again.`,
    };
  }

  const isOwner = BOT_OWNER_ID && claim.sender_id === String(BOT_OWNER_ID);
  const senderApiKey = getUserApiKey(claim.sender_id);
  const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
  if (!keyToUse) {
    // Don't mark as claimed — nothing was attempted, so the real recipient
    // must be able to retry once the sender reconnects a key.
    return { ok: false, reason: 'The sender no longer has a connected Quidli API key — ask them to reconnect and resend.' };
  }

  // Atomic claim-and-lock: only flips if still unclaimed/unexpired at this instant,
  // so two near-simultaneous clicks (e.g. Telegram retrying the update) can't both
  // pass through and trigger two transfers.
  const lock = db.prepare('UPDATE pending_claims SET claimed = 1 WHERE id = ? AND claimed = 0 AND expired = 0').run(claimId);
  if (lock.changes === 0) {
    return { ok: false, reason: 'This claim link is invalid, already used, or has expired.' };
  }

  const dropParams = JSON.parse(claim.drop_input);
  dropParams.recipients = [{ type: 'telegram', id: String(claimerTelegramId) }];

  try {
    const result = await quidliDrop(dropParams, keyToUse);
    const notifyChat = claim.chat_id ?? claim.sender_id;
    if (result.transferHash) {
      await tg.telegram.sendMessage(notifyChat,
        `✅ @${claim.recipient_username} claimed their tokens!\nhttps://basescan.org/tx/${result.transferHash}`
      ).catch(() => {});
    }
    return { ok: true, result };
  } catch (err) {
    console.error(`[claim] ${claimId} drop failed:`, err.message);
    db.prepare('UPDATE pending_claims SET claimed = 0 WHERE id = ?').run(claimId); // allow retry
    return { ok: false, reason: `Drop failed: ${err.message}` };
  }
}

function loadPendingClaims() {
  const pending = db.prepare('SELECT id, expires_at FROM pending_claims WHERE claimed = 0 AND expired = 0').all();
  for (const claim of pending) {
    scheduleClaimExpiry(claim.id, claim.expires_at * 1000);
  }
  if (pending.length) console.log(`[claim] re-queued ${pending.length} pending claim(s)`);
}

function loadPendingDrops() {
  const pending = db.prepare('SELECT id, drop_input, execute_at FROM scheduled_drops WHERE executed = 0').all();
  for (const job of pending) {
    const stored = JSON.parse(job.drop_input);
    const executeAt = job.execute_at * 1000;
    const delay = Math.max(0, executeAt - Date.now());
    if (stored.type === 'conditional') {
      setTimeout(() => executeConditionalDrop(job.id), delay);
    } else {
      scheduleDropJob(job.id, executeAt);
    }
    console.log(`[scheduled-drop] re-queued ${job.id} (executes in ${Math.round(delay / 60000)}m)`);
  }
}

// ─── LLM clients ──────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function getAnthropicClient(userApiKey) {
  if (userApiKey) return new Anthropic({ apiKey: userApiKey });
  return anthropic;
}

async function getGeminiClient(userApiKey) {
  const key = userApiKey || GEMINI_API_KEY;
  if (!key) throw new Error('No Gemini API key available. DM me /llm gemini <key> to connect your own.');
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey: key });
}

async function getOpenAIClient(userApiKey, baseURL) {
  const key = userApiKey || OPENAI_API_KEY;
  if (!key) throw new Error('No OpenAI API key available. DM me /llm openai <key> to connect your own.');
  const { default: OpenAI } = await import('openai');
  return new OpenAI({ apiKey: key, ...(baseURL ? { baseURL } : {}) });
}

function getGeminiTools() {
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
}

function getOpenAITools() {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

// ─── Telegram message editor ──────────────────────────────────────────────────

function chunkText(text, limit = TG_MSG_LIMIT) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }
  return chunks;
}

function createThrottledEditor(chatId, messageId) {
  let pending = null;
  let timer = null;
  let lastEdit = 0;
  let overflowMessageIds = [];

  async function flush() {
    if (pending === null) return;
    const text = pending;
    pending = null;

    const chunks = chunkText(text);
    const primary = chunks[0] ?? '…';
    const overflow = chunks.slice(1);

    try {
      await tg.telegram.editMessageText(chatId, messageId, null, primary);
      lastEdit = Date.now();

      for (let i = 0; i < overflow.length; i++) {
        if (overflowMessageIds[i]) {
          await tg.telegram.editMessageText(chatId, overflowMessageIds[i], null, overflow[i]).catch(() => {});
        } else {
          const msg = await tg.telegram.sendMessage(chatId, overflow[i]);
          overflowMessageIds.push(msg.message_id);
        }
      }
    } catch (err) {
      if (!err.message?.includes('message is not modified')) {
        console.warn('[tg] edit failed:', err.message);
      }
    }
  }

  return {
    update(newText) {
      pending = newText;
      const now = Date.now();
      const delay = Math.max(0, EDIT_THROTTLE_MS - (now - lastEdit));
      if (!timer) {
        timer = setTimeout(async () => {
          timer = null;
          await flush();
        }, delay);
      }
    },
    async finalize(finalText) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = finalText;
      await flush();
    },
  };
}

// ─── Agentic loops ────────────────────────────────────────────────────────────

async function runAnthropicLoop(contextId, contextualText, editor, toolCtx, userLlmKey, modelOverride) {
  const history = getAnthropicHistory(contextId);
  history.push({ role: 'user', content: contextualText });
  let messages = [...history];
  let accumulated = '';
  const client = getAnthropicClient(userLlmKey);
  const modelUsed = modelOverride || CLAUDE_MODEL;
  console.log(`[api-call] anthropic model="${modelUsed}" baseURL="api.anthropic.com" usingUserKey=${!!userLlmKey}`);

  while (true) {
    const response = await client.messages.create({
      model: modelUsed,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text') {
        accumulated += block.text;
        editor.update(accumulated || 'Thinking…');
      }
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      messages = [...messages, { role: 'assistant', content: response.content }];
      const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
        editor.update((accumulated || 'Thinking…') + '\nLooking up…');
        try {
          const result = await runTool(block.name, block.input, toolCtx);
          return { type: 'tool_result', tool_use_id: block.id, content: result };
        } catch (err) {
          console.error(`[tool] ${block.name} error:`, err.message);
          return { type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true };
        }
      }));
      messages = [...messages, { role: 'user', content: toolResults }];
      continue;
    }

    break;
  }

  history.push({ role: 'assistant', content: accumulated });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return accumulated;
}

async function runGeminiLoop(contextId, contextualText, editor, toolCtx, userLlmKey) {
  const ai = await getGeminiClient(userLlmKey);
  const history = getGeminiHistory(contextId);
  history.push({ role: 'user', parts: [{ text: contextualText }] });
  let contents = [...history];
  let accumulated = '';

  while (true) {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
      contents,
      tools: getGeminiTools(),
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text) { accumulated += part.text; editor.update(accumulated || 'Thinking…'); }
    }

    const funcCalls = parts.filter((p) => p.functionCall);
    if (funcCalls.length === 0) break;

    contents = [...contents, { role: 'model', parts }];
    editor.update((accumulated || 'Thinking…') + '\nLooking up…');

    const funcResponses = await Promise.all(funcCalls.map(async (part) => {
      const { name, args } = part.functionCall;
      try {
        const result = await runTool(name, args, toolCtx);
        return { functionResponse: { name, response: { result } } };
      } catch (err) {
        return { functionResponse: { name, response: { error: err.message } } };
      }
    }));

    contents = [...contents, { role: 'user', parts: funcResponses }];
  }

  history.push({ role: 'model', parts: [{ text: accumulated }] });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return accumulated;
}

async function runOpenAILoop(contextId, contextualText, editor, toolCtx, userLlmKey, { baseURL, model } = {}) {
  const openai = await getOpenAIClient(userLlmKey, baseURL);
  const modelToUse = model || OPENAI_MODEL;
  console.log(`[api-call] openai-compatible model="${modelToUse}" baseURL="${baseURL || 'api.openai.com (default)'}" usingUserKey=${!!userLlmKey}`);
  const history = getOpenAIHistory(contextId);
  history.push({ role: 'user', content: contextualText });
  let messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  let accumulated = '';

  while (true) {
    const response = await openai.chat.completions.create({ model: modelToUse, messages, tools: getOpenAITools(), tool_choice: 'auto' });
    const choice = response.choices[0];
    const msg = choice.message;

    if (msg.content) { accumulated += msg.content; editor.update(accumulated || 'Thinking…'); }
    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) break;

    messages = [...messages, msg];
    editor.update((accumulated || 'Thinking…') + '\nLooking up…');

    const toolResults = await Promise.all(msg.tool_calls.map(async (tc) => {
      let args;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      try {
        const result = await runTool(tc.function.name, args, toolCtx);
        return { role: 'tool', tool_call_id: tc.id, content: result };
      } catch (err) {
        return { role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` };
      }
    }));

    messages = [...messages, ...toolResults];
  }

  history.push({ role: 'assistant', content: accumulated });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  return accumulated;
}

// ─── Minds background handler ─────────────────────────────────────────────────

const MINDS_ALIAS_MAX_AGE_S = 4 * 60 * 60; // rotate conversation thread every 4 hours

async function runMindsBackground(contextId, text, chatId, pendingMsgId, senderId, mindName) {
  let creds = getUserMindsCredentials(senderId);
  if (!creds) {
    await tg.telegram.editMessageText(chatId, pendingMsgId, null,
      '⚠️ You need to connect your Minds agent.\nDM me /minds <builder-api-key> to connect.\nGet a Builder API key at https://build.hellominds.ai/console'
    ).catch(() => {});
    return;
  }

  // Rotate alias if older than 4 hours to prevent Minds falling back to email
  if (creds.mindId && creds.aliasCreatedAt) {
    const ageS = Math.floor(Date.now() / 1000) - creds.aliasCreatedAt;
    if (ageS > MINDS_ALIAS_MAX_AGE_S) {
      try {
        const rotateClient = createMindsClient({ builderApiKey: creds.apiKey });
        const newAlias = `tc${String(senderId).slice(-8)}${randomBytes(2).toString('hex')}`;
        await rotateClient.ensureConversation(newAlias, creds.mindId);
        setUserMindsCredentials(senderId, creds.apiKey, newAlias, creds.name, creds.mindId);
        creds = getUserMindsCredentials(senderId);
        console.log(`[minds] Rotated alias for ${senderId} → ${newAlias}`);
      } catch (err) {
        console.error('[minds-rotate] failed:', err.message);
        // Continue with old alias rather than failing
      }
    }
  }

  const { alias, apiKey } = creds;
  const userText = text.replace(/^\[Current date.*?\]\n\[Sent by.*?\]\s*/s, '').trim();
  const mindsClient = createMindsClient({ builderApiKey: apiKey });

  let afterFingerprint;
  try { afterFingerprint = await mindsClient.getLatestHistoryFingerprint(alias); } catch { }

  try {
    await mindsClient.sendMessage({ alias, messageText: userText });
  } catch (err) {
    await tg.telegram.editMessageText(chatId, pendingMsgId, null, `⚠️ Failed to send to Minds: ${err.message.slice(0, 200)}`).catch(() => {});
    return;
  }

  await tg.telegram.editMessageText(chatId, pendingMsgId, null, '⏳ Sent to your Mind…').catch(() => {});

  try {
    const outcome = await mindsClient.waitForReply({
      alias,
      timeoutMs: 300000,
      sentMessageText: userText,
      ...(afterFingerprint !== undefined ? { afterFingerprint } : {}),
    });

    let responseText;
    if (outcome.timedOut) {
      responseText = '⏳ Your Mind is taking longer than expected. Try again.';
    } else {
      responseText = stripHtml(outcome.reply?.messageText || '(no response)');
    }

    const finalText = `${responseText}\n— Minds (${mindName})`;
    const chunks = chunkText(finalText);
    await tg.telegram.editMessageText(chatId, pendingMsgId, null, chunks[0] ?? '…').catch(() => {});
    for (let i = 1; i < chunks.length; i++) {
      await tg.telegram.sendMessage(chatId, chunks[i]).catch(() => {});
    }
  } catch (err) {
    console.error('[minds-bg] error:', err.message);
    await tg.telegram.editMessageText(chatId, pendingMsgId, null, `⚠️ Minds error: ${err.message.slice(0, 200)}`).catch(() => {});
  }
}

// ─── Watchers ─────────────────────────────────────────────────────────────────

async function checkWatchers(chatId, senderId, username, text) {
  const watchers = db.prepare('SELECT * FROM watchers WHERE chat_id = ? AND fired = 0').all(String(chatId));
  for (const watcher of watchers) {
    if (!text.toLowerCase().includes(watcher.trigger_phrase.toLowerCase())) continue;
    if (String(senderId) === watcher.sender_id) continue; // creator can't win

    const winnerIds = JSON.parse(watcher.winner_ids);
    if (winnerIds.includes(String(senderId))) continue;

    winnerIds.push(String(senderId));
    const newCount = watcher.winner_count + 1;
    const done = newCount >= watcher.max_winners ? 1 : 0;
    db.prepare('UPDATE watchers SET winner_count = ?, winner_ids = ?, fired = ? WHERE id = ?')
      .run(newCount, JSON.stringify(winnerIds), done, watcher.id);

    const isOwner = BOT_OWNER_ID && watcher.sender_id === String(BOT_OWNER_ID);
    const senderApiKey = getUserApiKey(watcher.sender_id);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) continue;

    try {
      const dropInput = {
        ...JSON.parse(watcher.drop_input),
        recipients: [{ type: 'telegram', id: String(senderId) }],
      };
      const result = await quidliDrop(dropInput, keyToUse);
      if (result.transferHash) {
        const url = `https://basescan.org/tx/${result.transferHash}`;
        await tg.telegram.sendMessage(chatId, `🎉 @${username ?? senderId} triggered the drop by typing "${watcher.trigger_phrase}"!\nTransaction: ${url}`).catch(() => {});
        await tg.telegram.sendMessage(watcher.sender_id, `✅ Watcher triggered! ${username ?? senderId} typed "${watcher.trigger_phrase}".\nTransaction: ${url}`).catch(() => {});
      }
    } catch (err) {
      console.error('[watcher] drop failed:', err.message);
    }
  }
}

// ─── Telegram bot ─────────────────────────────────────────────────────────────

const tg = new Telegraf(TELEGRAM_TOKEN, { handlerTimeout: Infinity });

// ── DM / private chat commands ────────────────────────────────────────────────

tg.command('connect', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const apiKey = ctx.message.text.replace('/connect', '').trim();
  if (!apiKey) {
    return ctx.reply('Usage: /connect <your-api-key>\nGet a key at https://connect.quid.li');
  }
  setUserApiKey(ctx.from.id, apiKey);
  ctx.reply(
    '✅ Connected! Drops will now use your Smart Send wallet.\n\n' +
    '⚠️ Your API key is stored encrypted and only has access to your Smart Send balance — not your main wallet. ' +
    'DM /revoke anytime to disconnect.'
  );
});

tg.command('revoke', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const had = getUserApiKey(ctx.from.id);
  deleteUserApiKey(ctx.from.id);
  ctx.reply(had
    ? '🗑️ Your API key has been removed.'
    : "You don't have a key stored. Nothing to remove."
  );
});

tg.command('minds', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const parts = ctx.message.text.replace('/minds', '').trim().split(/\s+/);
  const apiKey = parts[0];
  const mindName = parts[1] || null;

  if (!apiKey) {
    return ctx.reply(
      'Usage:\n/minds <builder-api-key> — connect your first enabled Mind\n/minds <builder-api-key> <mind-name> — connect a specific Mind\n\nGet a Builder API key at https://build.hellominds.ai/console'
    );
  }

  try {
    const client = createMindsClient({ builderApiKey: apiKey });
    const minds = await client.listMinds();
    const enabledMinds = minds.filter((m) => m.isEnabled);

    if (enabledMinds.length === 0) {
      return ctx.reply('❌ No enabled Minds found on your account. Visit https://build.hellominds.ai to set one up.');
    }

    let selectedMind;
    if (mindName) {
      selectedMind = enabledMinds.find((m) => m.name.toLowerCase() === mindName.toLowerCase());
      if (!selectedMind) {
        const names = enabledMinds.map((m) => m.name).join(', ');
        return ctx.reply(`❌ Mind "${mindName}" not found or not enabled.\nYour enabled Minds: ${names}`);
      }
    } else {
      selectedMind = enabledMinds[0];
    }

    const userAlias = `tc${String(ctx.from.id).slice(-8)}${randomBytes(2).toString('hex')}`;
    await client.ensureConversation(userAlias, selectedMind.mindId);
    setUserMindsCredentials(ctx.from.id, apiKey, userAlias, selectedMind.name, selectedMind.mindId);

    const otherMinds = enabledMinds.filter((m) => m.mindId !== selectedMind.mindId);
    const switchHint = otherMinds.length > 0
      ? `\n\nTo use a different Mind: /minds <key> <mind-name>\nYour other Minds: ${otherMinds.map((m) => m.name).join(', ')}`
      : '';

    ctx.reply(`✅ Connected to your ${selectedMind.name} Mind. When the chat is in Minds mode, your messages will go to this Mind.${switchHint}`);
  } catch (err) {
    ctx.reply(`❌ Failed to connect: ${err.message}`);
  }
});

tg.command('minds_remove', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  deleteUserMindsCredentials(ctx.from.id);
  ctx.reply('🗑️ Your Minds credentials have been removed.');
});

tg.command('llm', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const parts = ctx.message.text.replace('/llm', '').trim().split(/\s+/);
  const provider = parts[0]?.toLowerCase();
  const apiKey = parts[1];
  const model = parts[2] || null; // optional, only used for openrouter

  if (!provider || !apiKey) {
    return ctx.reply(
      'Usage: /llm <provider> <api-key>\n\n' +
      'Providers:\n' +
      '  anthropic  — from console.anthropic.com\n' +
      '  gemini     — from aistudio.google.com/apikey\n' +
      '  openai     — from platform.openai.com\n' +
      '  openrouter — from openrouter.ai (access 100+ models)\n' +
      '  hermes     — from portal.nousresearch.com (API keys)\n\n' +
      'For OpenRouter, you can optionally specify a model:\n' +
      '  /llm openrouter <key> [model]\n' +
      '  Example: /llm openrouter sk-or-... meta-llama/llama-3-70b-instruct\n' +
      '  Default model: openai/gpt-4o\n\n' +
      'Your key is stored encrypted and used instead of the host key. DM /llm_remove to disconnect.'
    );
  }

  if (!['anthropic', 'gemini', 'openai', 'openrouter', 'hermes'].includes(provider)) {
    return ctx.reply('Unknown provider. Use: anthropic, gemini, openai, openrouter, or hermes');
  }

  setUserLlmKey(ctx.from.id, provider, apiKey, model);
  const modelNote = provider === 'openrouter' ? ` (model: ${model || 'openai/gpt-4o'})` : '';
  ctx.reply(
    `✅ Connected your ${provider} key${modelNote}. Your messages will now use your own ${provider} credits.\n\n` +
    '⚠️ Your key is stored encrypted. DM /llm_remove anytime to disconnect.'
  );
});

tg.command('llm_remove', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const prov = ctx.message.text.replace('/llm_remove', '').trim().toLowerCase() || null;
  deleteUserLlmKey(ctx.from.id, prov);
  ctx.reply(prov
    ? `🗑️ Your ${prov} key has been removed.`
    : '🗑️ All your LLM keys have been removed. The bot will use host keys going forward.');
});

// ── /start — handles both plain start and claim deep links (?start=claim_<id>) ─
tg.start(async (ctx) => {
  const payload = ctx.startPayload ?? '';
  recordChatMember(ctx.chat.id, ctx.from.id, ctx.from.username ?? ctx.from.first_name ?? String(ctx.from.id));

  if (!payload.startsWith('claim_')) {
    return ctx.reply(
      "I'm TeleCentaur, your crypto-sending assistant. Mention me in a group or DM me to send USDC, check wallets, and more.\n\n" +
      'DM /connect <your-api-key> to link your own Quidli wallet — get a key at connect.quid.li'
    );
  }

  const claimId = payload.slice('claim_'.length);
  const outcome = await executeClaimedDrop(claimId, ctx.from.id, ctx.from.username);
  if (outcome.ok) {
    const finalText = outcome.result.transferHash
      ? `🎉 You've claimed your tokens!\nhttps://basescan.org/tx/${outcome.result.transferHash}`
      : "🎉 You've claimed your tokens!";
    await ctx.reply(finalText);
  } else {
    await ctx.reply(`⚠️ ${outcome.reason}`);
  }
});

// ── Main message handler ──────────────────────────────────────────────────────

tg.on(messageFilter('text'), async (ctx) => {
  const msg = ctx.message;
  const senderId = String(msg.from.id);
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const text = msg.text ?? '';
  const username = msg.from.username ?? msg.from.first_name ?? senderId;

  // In groups: only respond when mentioned or replied to
  const isPrivate = chatType === 'private';
  const botUsername = tg.botInfo?.username;
  const isMentioned = botUsername && text.includes(`@${botUsername}`);
  const isReplyToBot = msg.reply_to_message?.from?.id === tg.botInfo?.id;

  // Track everyone who messages the bot — in groups (so "everyone" drops work)
  // and in DMs (so resolve_telegram_username can find anyone who's ever messaged the bot directly)
  recordChatMember(chatId, senderId, username);

  if (!isPrivate && !isMentioned && !isReplyToBot) {
    // Still check watchers even if not mentioned
    await checkWatchers(chatId, senderId, username, text).catch((err) => console.error('[watcher] error:', err.message));
    return;
  }

  // Skip DM commands (handled by command handlers above)
  if (isPrivate && (text.startsWith('/connect') || text.startsWith('/revoke') || text.startsWith('/minds') || text.startsWith('/llm'))) {
    return;
  }

  // Access control
  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(senderId)) {
    await ctx.reply('You are not authorized to use this bot.').catch(() => {});
    return;
  }

  // Owner check — used for BYOLLM exemption and wallet note below
  const isOwner = BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID);

  // Peek at provider intent before BYOLLM check — Minds doesn't need an LLM key
  const cleanTextPeek = botUsername
    ? text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim()
    : text.trim();
  const switchPeek = detectProviderSwitch(cleanTextPeek);
  const isMindsContext = switchPeek === 'minds' || getChannelProvider(String(chatId)) === 'minds';

  // BYOLLM enforcement — if host requires users to bring their own key (owner is always exempt)
  // Minds users bypass this — they authenticate via Minds credentials, not LLM keys
  if (REQUIRE_USER_LLM && !isOwner && !isMindsContext && !hasAnyUserLlmKey(senderId)) {
    await ctx.reply(
      'This bot requires you to connect your own AI API key.\n\n' +
      'DM me to set it up:\n' +
      '/llm anthropic <key> — from console.anthropic.com\n' +
      '/llm gemini <key> — from aistudio.google.com/apikey\n' +
      '/llm openai <key> — from platform.openai.com\n' +
      '/llm openrouter <key> — from openrouter.ai (100+ models)\n' +
      '/llm hermes <key> — from portal.nousresearch.com\n\n' +
      'Or use Minds — connect your Minds AI agent:\n' +
      '/minds <alias> <builderApiKey>'
    ).catch(() => {});
    return;
  }

  // Strip bot mention from text
  const cleanText = botUsername
    ? text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim()
    : text.trim();

  if (!cleanText) {
    await ctx.reply('What can I help you with?').catch(() => {});
    return;
  }

  const contextId = String(chatId);

  // ── Provider switch detection ────────────────────────────────────────────────
  const switchTarget = detectProviderSwitch(cleanText);
  if (switchTarget) {
    if (switchTarget === 'gemini' && !GEMINI_API_KEY) {
      await ctx.reply('⚠️ GEMINI_API_KEY is not set in .env.').catch(() => {});
      return;
    }
    if (switchTarget === 'openai' && !OPENAI_API_KEY) {
      await ctx.reply('⚠️ OPENAI_API_KEY is not set in .env.').catch(() => {});
      return;
    }
    if (switchTarget === 'hermes' && !NOUS_API_KEY && !getUserLlmKeyFor(senderId, 'hermes')) {
      await ctx.reply('⚠️ NOUS_API_KEY is not set in .env, and you don\'t have a personal Hermes key connected. DM me /llm hermes <key> (get one at portal.nousresearch.com).').catch(() => {});
      return;
    }

    let namedModel = null;
    if (switchTarget === 'openrouter') {
      const orKey = getUserLlmKeyFor(senderId, 'openrouter');
      if (!orKey) {
        await ctx.reply(
          '⚠️ You need an OpenRouter key for that model.\n' +
          'DM me /llm openrouter <key> to set up. Get one at openrouter.ai/keys'
        ).catch(() => {});
        return;
      }
      // "switch to kimi" names a model; plain "switch to openrouter" keeps the user's stored default
      namedModel = detectOpenRouterModel(cleanText) || orKey.model || 'openai/gpt-4o';
    } else if (switchTarget === 'anthropic') {
      // "switch to fable/opus/haiku/sonnet" names a model; plain "switch to claude" uses the default
      namedModel = detectAnthropicModel(cleanText);
    }

    setChannelProvider(contextId, switchTarget, namedModel);
    anthropicHistories.delete(contextId);
    geminiHistories.delete(contextId);
    openaiHistories.delete(contextId);
    const modelName = switchTarget === 'gemini' ? GEMINI_MODEL
      : switchTarget === 'openai' ? OPENAI_MODEL
      : switchTarget === 'hermes' ? NOUS_MODEL
      : switchTarget === 'minds' ? 'Minds'
      : (namedModel || CLAUDE_MODEL);
    await ctx.reply(`🔀 Switched to ${modelName}. Starting a fresh conversation.`).catch(() => {});
    return;
  }

  const provider = getChannelProvider(contextId);

  // Send placeholder then edit it as response comes in
  const pendingMsg = await ctx.reply('Thinking…').catch((err) => {
    console.error('[tg] reply failed:', err.message);
    return null;
  });
  if (!pendingMsg) return;

  const editor = createThrottledEditor(chatId, pendingMsg.message_id);

  // Build context prefix
  const senderApiKey = getUserApiKey(senderId);
  const walletNote = senderApiKey
    ? '[User has a personal Quidli API key connected — drops will use their Smart Send wallet]'
    : isOwner
      ? '[User is the bot owner — drops will use the host Smart Send wallet]'
      : '[User has NO personal Quidli API key — do NOT execute any drops. If they request a drop, tell them they must first DM me /connect <your-api-key> to link their Quidli account (get a key at connect.quid.li). Do not proceed with any token transfer.]';

  const now = new Date();
  const timeContext = `[Current date and time: ${now.toUTCString()} | Local ISO: ${now.toISOString()}]`;
  const senderContext = `[Sent by @${username} (Telegram ID: ${senderId})]`;
  const contextualText = `${timeContext}\n${senderContext} ${walletNote}\n${cleanText}`;

  const toolCtx = {
    senderId,
    senderApiKey,
    currentChatId: chatId,
    isPrivateChat: isPrivate,
  };

  let accumulated = '';
  let modelLabel = CLAUDE_MODEL;

  _pendingBasescanUrls.length = 0;

  try {
    // The chat's switched provider decides what runs. Each user's messages use
    // their own key for that provider if they have one, else the host key.
    const effectiveProvider = provider;
    const chModel = getChannelModel(contextId); // chat-level model override, set by e.g. "switch to fable"
    const anthKey = getUserLlmKeyFor(senderId, 'anthropic');
    const orKey = getUserLlmKeyFor(senderId, 'openrouter');

    if (effectiveProvider === 'gemini') {
      accumulated = await runGeminiLoop(contextId, contextualText, editor, toolCtx, getUserLlmKeyFor(senderId, 'gemini')?.apiKey ?? null);
      modelLabel = GEMINI_MODEL;
    } else if (effectiveProvider === 'openai') {
      accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, getUserLlmKeyFor(senderId, 'openai')?.apiKey ?? null);
      modelLabel = OPENAI_MODEL;
    } else if (effectiveProvider === 'openrouter') {
      if (!orKey) {
        await editor.finalize(
          '⚠️ This chat is in OpenRouter mode, but you don\'t have an OpenRouter key connected.\n' +
          'DM me /llm openrouter <key> to set up (openrouter.ai/keys), or say "switch to claude" to change modes.'
        );
        return;
      }
      const orModel = chModel || orKey.model || 'openai/gpt-4o';
      accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, orKey.apiKey, {
        baseURL: 'https://openrouter.ai/api/v1',
        model: orModel,
      });
      modelLabel = orModel;
    } else if (effectiveProvider === 'hermes') {
      const hermesUserKey = getUserLlmKeyFor(senderId, 'hermes')?.apiKey ?? null;
      const hermesKey = hermesUserKey || NOUS_API_KEY;
      if (!hermesKey) {
        await editor.finalize(
          '⚠️ This chat is in Hermes mode, but no NOUS_API_KEY is set in .env and you don\'t have a personal Hermes key connected.\n' +
          'DM me /llm hermes <key> to set up (portal.nousresearch.com), or say "switch to claude" to change modes.'
        );
        return;
      }
      const hermesModel = chModel || NOUS_MODEL;
      accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, hermesKey, {
        baseURL: NOUS_API_BASE_URL,
        model: hermesModel,
      });
      modelLabel = hermesModel;
    } else if (effectiveProvider === 'minds') {
      const creds = getUserMindsCredentials(senderId);
      const mindName = creds?.name ?? 'unknown';

      // If this looks like a confirmation, re-fetch Minds history to check for a pending action.
      // Using getHistory instead of in-memory state so handoffs survive bot restarts.
      let handoffText = null;
      if (creds && isPositiveConfirmation(cleanText)) {
        try {
          const mindsClient = createMindsClient({ builderApiKey: creds.apiKey });
          const history = await mindsClient.getHistory(creds.alias, { limit: 10 });
          const lastMindReply = history.findLast((row) => isReplyHistoryRow(row));
          if (lastMindReply) {
            const age = Date.now() - new Date(lastMindReply.createdAt).getTime();
            const pendingText = stripHtml(lastMindReply.messageText ?? '');
            if (age < 60 * 60 * 1000 && looksLikePendingAction(pendingText)) {
              handoffText =
                `${timeContext}\n${senderContext} ${walletNote}\n` +
                `The user's Minds AI agent researched and prepared the following action plan. ` +
                `The user has now confirmed it. Execute it immediately using your tools — no further confirmation needed:\n\n` +
                `---\n${pendingText}\n---\n\n` +
                `User confirmed: "${cleanText}"`;
            }
          }
        } catch (err) {
          console.error('[minds-history] error:', err.message);
          await tg.telegram.editMessageText(chatId, pendingMsg.message_id, undefined,
            '⚠️ Could not verify pending action — please try again.').catch(() => {});
          return;
        }
      }

      if (handoffText) {
        accumulated = await runAnthropicLoop(contextId, handoffText, editor, toolCtx, anthKey?.apiKey ?? null);
        modelLabel = `${CLAUDE_MODEL} (via Minds)`;
      } else {
        runMindsBackground(contextId, contextualText, chatId, pendingMsg.message_id, senderId, mindName)
          .catch((err) => console.error('[minds-bg] unhandled:', err.message));
        return;
      }
    } else {
      // anthropic (default). BYOLLM users without an Anthropic key but with an
      // OpenRouter key get Claude routed through OpenRouter on their own credits.
      if (REQUIRE_USER_LLM && !isOwner && !anthKey && orKey) {
        accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, orKey.apiKey, {
          baseURL: 'https://openrouter.ai/api/v1',
          model: OPENROUTER_CLAUDE_SLUG,
        });
        modelLabel = `${OPENROUTER_CLAUDE_SLUG} (via OpenRouter)`;
      } else {
        accumulated = await runAnthropicLoop(contextId, contextualText, editor, toolCtx, anthKey?.apiKey ?? null, chModel);
        modelLabel = chModel || CLAUDE_MODEL;
      }
    }

    let finalText = accumulated || '(no response)';
    finalText = sanitizeUnverifiedTxClaims(finalText, _pendingBasescanUrls);
    for (const url of _pendingBasescanUrls) {
      if (!finalText.includes(url)) finalText += `\n🔗 ${url}`;
    }
    _pendingBasescanUrls.length = 0;

    finalText += `\n— ${modelLabel}`;
    await editor.finalize(finalText);

  } catch (err) {
    console.error(`[${provider}] error:`, err);
    if (provider === 'gemini') { const h = getGeminiHistory(contextId); if (h.at(-1)?.role === 'user') h.pop(); }
    else if (provider === 'openai' || provider === 'hermes') { const h = getOpenAIHistory(contextId); if (h.at(-1)?.role === 'user') h.pop(); }
    else { const h = getAnthropicHistory(contextId); if (h.at(-1)?.role === 'user') h.pop(); }
    await editor.finalize(`⚠️ Error: ${err.message?.slice(0, 200) ?? 'Unknown error'}`);
  }

  // Also check watchers (in case bot message triggered one)
  await checkWatchers(chatId, senderId, username, cleanText).catch(() => {});
});

// ─── Launch ───────────────────────────────────────────────────────────────────

tg.launch({
  allowedUpdates: ['message', 'callback_query'],
}).then(() => {
  console.log(`✅ TeleCentaur ready — @${tg.botInfo?.username}`);
  console.log(`   Default LLM: ${DEFAULT_LLM_PROVIDER}`);
  if (GEMINI_API_KEY) console.log(`   Gemini: ${GEMINI_MODEL} ✓`);
  if (OPENAI_API_KEY) console.log(`   OpenAI: ${OPENAI_MODEL} ✓`);
  if (NOUS_API_KEY) console.log(`   Hermes: ${NOUS_MODEL} ✓ (via Nous Portal — not tuned for tool-calling, per Nous's own guidance)`);
  console.log(`   Minds: per-user keys (DM /minds <key> to register)`);
  console.log(`   Quidli: ${QUIDLI_API_KEY ? 'API key' : 'x402 payments'}`);
  console.log(`   Key storage: ${encKey ? 'encrypted (AES-256-GCM)' : '⚠️  plaintext — set MASTER_ENCRYPTION_KEY to encrypt'}`);
  loadPendingDrops();
  loadPendingClaims();
});

process.once('SIGINT', () => tg.stop('SIGINT'));
process.once('SIGTERM', () => tg.stop('SIGTERM'));
