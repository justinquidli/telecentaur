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
  NOUS_API_KEY,             // Nous Portal API key — from portal.nousresearch.com (API keys)
  // Host default model. Portal is an OpenRouter-compatible proxy, so slugs are
  // vendor-prefixed and free variants carry a ':free' suffix. Free-tier models that
  // support tool calling (verified via /v1/models): tencent/hy3:free,
  // inclusionai/ling-3.0-flash:free, poolside/laguna-s-2.1:free,
  // poolside/laguna-xs-2.1:free, stepfun/step-3.7-flash:free.
  // Paid tiers can use any of the 200+ slugs (anthropic/claude-sonnet-4.6, etc).
  // Users can override per-chat with: /llm hermes <key> <model>
  NOUS_MODEL = 'tencent/hy3:free',
  REQUIRE_USER_LLM_KEY = 'false', // Legacy — host keys are now owner/allowlist-only regardless
  // Who may spend the HOST's LLM keys. The owner always can. Everyone else must
  // either be listed here or connect their own key for the provider in use.
  // Comma-separated Telegram @handles and/or numeric IDs, e.g. "alice,482970829"
  HOST_KEY_ALLOWED_USERS = '',
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

// Handles/IDs permitted to spend the host's LLM keys (owner is always permitted).
const HOST_KEY_USERS = new Set(
  HOST_KEY_ALLOWED_USERS.split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
);

// Providers that would otherwise silently fall back to a host key.
// 'openrouter' and 'minds' are per-user by design and never touch host credentials.
const HOST_KEY_PROVIDERS = new Set(['anthropic', 'gemini', 'openai', 'hermes']);

function mayUseHostKey(senderId, username) {
  if (BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID)) return true;
  if (HOST_KEY_USERS.has(String(senderId).toLowerCase())) return true;
  if (username && HOST_KEY_USERS.has(String(username).replace(/^@/, '').toLowerCase())) return true;
  return false;
}

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

## Checking balance (connect_drop_balance)
- Use connect_drop_balance to answer "what's my balance", "how much do I have", "can I afford X". It takes a chainId (8453 = Base) and returns native and ERC-20 balances for the sender's Smart Send wallet.
- Balances come back as balanceInWei with a decimals field — divide before showing a human number, and use the symbol from the response.
- Before a drop that looks large, or after a drop fails for funding reasons, check the balance and say plainly what's short — the token or the gas.
- Do NOT check balance before every routine drop; it's an extra call and most drops are fine.

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
// Superseded by chat_user_agent below — kept so existing rows don't error.
try { db.exec(`ALTER TABLE chat_settings ADD COLUMN agent_name TEXT`); } catch { }

// Which agent a member's unprefixed messages go to, per chat. Keyed by user as
// well as chat because agents are owned per-user: in a group, your default is
// yours and can't be changed or cleared by anyone else speaking.
// Agents in a group read the recent channel digest, which means one member's
// messages reach whatever model another member chose, on their key. That's a
// disclosure, so the room gets told once — tracked here so it fires exactly once.
db.exec(`CREATE TABLE IF NOT EXISTS chat_agent_notice (
  context_id TEXT PRIMARY KEY,
  notified_at INTEGER DEFAULT (unixepoch())
)`);

db.exec(`CREATE TABLE IF NOT EXISTS chat_user_agent (
  context_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (context_id, user_id)
)`);
// Carry over any chat-wide default set before this was per-user. Safe because
// agents were DM-only until now, so context_id identifies exactly one user.
try {
  db.exec(`INSERT OR IGNORE INTO chat_user_agent (context_id, user_id, agent_name)
    SELECT context_id, context_id, agent_name FROM chat_settings WHERE agent_name IS NOT NULL`);
} catch (err) {
  console.error('[migrate] chat default agent → per-user failed (non-fatal):', err.message);
}
db.exec(`CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  username   TEXT,
  first_seen INTEGER DEFAULT (unixepoch()),
  last_seen  INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, user_id)
)`);

// ── Named agents ──────────────────────────────────────────────────────────────
// A user-owned, user-named configuration you address as a slash command. `kind`
// decides how it runs: 'llm' uses provider+model through the normal loops,
// 'minds' routes to a Mind via its own alias. Stock providers are backfilled as
// agents so `/claude` and `/hermes` exist without anyone creating them, and so
// there is exactly one concept to learn.
db.exec(`CREATE TABLE IF NOT EXISTS user_agents (
  user_id     TEXT NOT NULL,
  agent_name  TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'llm',
  provider    TEXT,
  model       TEXT,
  base_url    TEXT,
  headers     TEXT,
  mind_id     TEXT,
  alias       TEXT,
  alias_at    INTEGER,
  description TEXT,
  is_stock    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, agent_name)
)`);

// Deliberately no "default agent" table. Agents are only ever reached by an
// explicit /name in a DM; everything else keeps today's behaviour, including
// `switch to X` setting the chat provider. One job per verb, no overlap.

// (Migration of any pre-existing single Mind into an agent runs further down,
//  once the slugging helpers it needs are defined.)

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

// Note: the legacy single-Mind accessors were removed when Minds moved to the
// agent registry. The columns stay so the one-time migration keeps working for
// databases that haven't run it yet; deleteUserMindsCredentials still clears them.
function deleteUserMindsCredentials(telegramId) {
  db.prepare('UPDATE user_keys SET minds_alias = NULL, minds_api_key = NULL, minds_name = NULL, minds_mind_id = NULL, minds_alias_created_at = NULL WHERE telegram_id = ?').run(String(telegramId));
}

function getUserLlmKeyFor(telegramId, provider) {
  const row = db.prepare('SELECT api_key, model FROM user_llm_keys WHERE user_id = ? AND provider = ?').get(String(telegramId), provider);
  if (!row?.api_key) return null;
  return { provider, apiKey: decrypt(row.api_key), model: row.model ?? null };
}

function setUserLlmKey(telegramId, provider, apiKey, model) {
  db.prepare(`INSERT INTO user_llm_keys (user_id, provider, api_key, model)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET api_key = excluded.api_key, model = COALESCE(excluded.model, user_llm_keys.model)`)
    .run(String(telegramId), provider, encrypt(apiKey), model ?? null);
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

// ── Agent registry ────────────────────────────────────────────────────────────

// Stock agents exist for everyone without being stored. They're synthesized on
// lookup, so there's no backfill and no rows for users who never use agents.
// A user can customise one (e.g. set a model) — that writes a real row which
// shadows the stock entry from then on.
const STOCK_AGENTS = {
  claude:     { kind: 'llm', provider: 'anthropic' },
  gemini:     { kind: 'llm', provider: 'gemini' },
  openai:     { kind: 'llm', provider: 'openai' },
  nous:       { kind: 'llm', provider: 'hermes' },
  openrouter: { kind: 'llm', provider: 'openrouter' },
};

// The internal provider id stays 'hermes' so stored keys and chat settings keep
// resolving, but it points at Nous Portal and usually runs a non-Nous model, so
// showing "hermes" to users was simply wrong. Display names live here.
const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  openai: 'OpenAI',
  hermes: 'Nous Portal',
  openrouter: 'OpenRouter',
  endpoint: 'agent endpoint',
  minds: 'Minds',
};
const providerLabel = (p) => PROVIDER_LABELS[p] ?? p;

// /hermes was the old name for what is now /nous. Kept resolving so anything
// typed before — or stored in chat_settings — still works, without listing both.
const AGENT_NAME_ALIASES = {
  hermes: 'nous',
};

// Names double as Telegram commands, so they must be lowercase a-z0-9_ and <=32.
function normalizeAgentName(raw) {
  const slug = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return slug || null;
}

// Commands the bot already owns — an agent named `minds` would shadow /minds.
const RESERVED_AGENT_NAMES = new Set([
  'agent', 'agents', 'minds', 'minds_remove', 'llm', 'llm_remove',
  'connect', 'revoke', 'start', 'help',
]);

// The host key for a provider, or null if the host hasn't configured one.
// OpenRouter is deliberately absent — it's bring-your-own-key by design.
function hostKeyFor(provider) {
  return provider === 'anthropic' ? (ANTHROPIC_API_KEY || null)
    : provider === 'gemini' ? (GEMINI_API_KEY || null)
    : provider === 'openai' ? (OPENAI_API_KEY || null)
    : provider === 'hermes' ? (NOUS_API_KEY || null)
    : null;
}

function defaultModelForProvider(provider) {
  return provider === 'gemini' ? GEMINI_MODEL
    : provider === 'openai' ? OPENAI_MODEL
    : provider === 'hermes' ? NOUS_MODEL
    : provider === 'anthropic' ? CLAUDE_MODEL
    : null; // openrouter resolves from the user's stored key
}

function getAgent(userId, name) {
  let agentName = normalizeAgentName(name);
  if (!agentName) return null;
  const row = db.prepare('SELECT * FROM user_agents WHERE user_id = ? AND agent_name = ?')
    .get(String(userId), agentName);
  if (row) return row;
  // Only alias to a stock agent — a user's own /hermes must still be their own.
  if (AGENT_NAME_ALIASES[agentName]) agentName = AGENT_NAME_ALIASES[agentName];
  const stock = STOCK_AGENTS[agentName];
  if (!stock) return null;
  return { user_id: String(userId), agent_name: agentName, ...stock, model: null, is_stock: 1 };
}

// `switch to minds` needs a single Mind to route to. Oldest registered wins, so
// the one migrated from the pre-agent setup stays the one that mode uses.
function firstMindsAgent(userId) {
  return db.prepare(`SELECT * FROM user_agents WHERE user_id = ? AND kind = 'minds'
    ORDER BY created_at, agent_name LIMIT 1`).get(String(userId)) ?? null;
}

function listAgents(userId) {
  const rows = db.prepare('SELECT * FROM user_agents WHERE user_id = ? ORDER BY agent_name').all(String(userId));
  const owned = new Set(rows.map((r) => r.agent_name));
  const stock = Object.entries(STOCK_AGENTS)
    .filter(([n]) => !owned.has(n))
    .map(([n, s]) => ({ user_id: String(userId), agent_name: n, ...s, model: null, is_stock: 1 }));
  return [...rows, ...stock];
}

function upsertAgent(userId, agentName, fields) {
  const cols = ['kind', 'provider', 'model', 'base_url', 'headers', 'mind_id', 'alias', 'alias_at', 'description'];
  const existing = db.prepare('SELECT * FROM user_agents WHERE user_id = ? AND agent_name = ?')
    .get(String(userId), agentName);
  const merged = {};
  for (const c of cols) merged[c] = fields[c] !== undefined ? fields[c] : (existing?.[c] ?? null);
  db.prepare(`INSERT INTO user_agents (user_id, agent_name, kind, provider, model, base_url, headers, mind_id, alias, alias_at, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, agent_name) DO UPDATE SET
      kind = excluded.kind, provider = excluded.provider, model = excluded.model,
      base_url = excluded.base_url, headers = excluded.headers, mind_id = excluded.mind_id,
      alias = excluded.alias, alias_at = excluded.alias_at, description = excluded.description`)
    .run(String(userId), agentName, merged.kind ?? 'llm', merged.provider, merged.model,
         merged.base_url, merged.headers, merged.mind_id, merged.alias, merged.alias_at, merged.description);
}

// Each agent keeps its own thread via a composite history key, so switching
// between them no longer clobbers anything.
function agentContextId(contextId, agentName) {
  return agentName ? `${contextId}::${agentName}` : String(contextId);
}

function clearAgentHistory(contextId, agentName) {
  const key = agentContextId(contextId, agentName);
  anthropicHistories.delete(key);
  geminiHistories.delete(key);
  openaiHistories.delete(key);
}

function renameAgent(userId, from, to) {
  db.prepare('UPDATE user_agents SET agent_name = ? WHERE user_id = ? AND agent_name = ?')
    .run(to, String(userId), from);
  // Follow the rename so a chat pointed at this agent doesn't strand itself.
  db.prepare('UPDATE chat_user_agent SET agent_name = ? WHERE user_id = ? AND agent_name = ?')
    .run(to, String(userId), from);
  // An endpoint agent's bearer token is filed under its name — move it too, or
  // the renamed agent silently loses auth.
  db.prepare('UPDATE user_llm_keys SET provider = ? WHERE user_id = ? AND provider = ?')
    .run(`endpoint:${to}`, String(userId), `endpoint:${from}`);
}

function deleteAgent(userId, agentName) {
  db.prepare('DELETE FROM user_agents WHERE user_id = ? AND agent_name = ?').run(String(userId), agentName);
  db.prepare('DELETE FROM user_llm_keys WHERE user_id = ? AND provider = ?')
    .run(String(userId), `endpoint:${agentName}`);
  db.prepare('DELETE FROM chat_user_agent WHERE user_id = ? AND agent_name = ?')
    .run(String(userId), agentName);
}

// In a group, two people can both own an agent called "tim", so a reply has to
// say whose it is. In a DM there's only one owner, so the tag is noise.
function agentTag(agent, ownerName, isPrivate) {
  return isPrivate ? agent.agent_name : `${agent.agent_name} (@${ownerName})`;
}

// True the first time an agent is used in a given group, so the room can be
// told once that agents here can read recent messages.
function claimAgentNotice(contextId) {
  return db.prepare('INSERT OR IGNORE INTO chat_agent_notice (context_id) VALUES (?)')
    .run(String(contextId)).changes > 0;
}

// Human-readable backing, used in /agents and the reply label.
function describeAgent(agent) {
  if (!agent) return '';
  if (agent.kind === 'minds') return `Minds · ${agent.description || agent.agent_name}`;
  if (agent.base_url) return `agent endpoint${agent.model && agent.model !== 'hermes-agent' ? ` · ${agent.model}` : ''}`;
  const model = agent.model || defaultModelForProvider(agent.provider) || 'your key\'s default';
  return `${providerLabel(agent.provider)} · ${model}`;
}

// The Minds builder key is one-per-user and covers every Mind on the account,
// so it stays where it already lives rather than being copied onto each agent.
function getMindsBuilderKey(telegramId) {
  const row = db.prepare('SELECT minds_api_key FROM user_keys WHERE telegram_id = ?').get(String(telegramId));
  return row?.minds_api_key ? decrypt(row.minds_api_key) : null;
}

function mintMindsAlias(telegramId) {
  return `tc${String(telegramId).slice(-8)}${randomBytes(2).toString('hex')}`;
}

function setUserMindsBuilderKey(telegramId, apiKey) {
  db.prepare(`INSERT INTO user_keys (telegram_id, minds_api_key) VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET minds_api_key = excluded.minds_api_key`)
    .run(String(telegramId), encrypt(apiKey));
}

// Telegram replaces (never merges) the command list for a scope, so the base
// list lives here in code. Publishing base + agents means a user's existing
// commands can't be lost by adding an agent.
const BASE_COMMANDS = [
  { command: 'agents', description: 'List your agents' },
  { command: 'agent', description: 'Create or manage an agent' },
  { command: 'connect', description: 'Link your Quidli API key' },
  { command: 'revoke', description: 'Remove your Quidli API key' },
  { command: 'llm', description: 'Use your own LLM key' },
  { command: 'llm_remove', description: 'Remove your LLM key' },
  { command: 'minds', description: 'Connect your Minds agents' },
  { command: 'minds_remove', description: 'Remove your Minds credentials' },
];

// Best-effort: agents still work by typing even if this fails.
async function refreshAgentCommands(ctx) {
  try {
    const agents = listAgents(ctx.from.id)
      .filter((a) => !a.is_stock)
      .map((a) => ({
        command: a.agent_name,
        description: (describeAgent(a) || 'agent').slice(0, 256),
      }));
    await ctx.telegram.setMyCommands([...BASE_COMMANDS, ...agents], {
      scope: { type: 'chat', chat_id: ctx.chat.id },
    });
  } catch (err) {
    console.error('[agents] setMyCommands failed:', err.message);
  }
}

// A stable per-agent conversation handle for OpenAI-compatible agent endpoints
// (sent as X-Hermes-Session-Key). Generated once and stored, so renaming an
// agent doesn't silently reset its memory.
function mintSessionKey(telegramId) {
  return `telecentaur:${telegramId}:${randomBytes(4).toString('hex')}`;
}

// Endpoint agents keep their bearer token in the encrypted key store, filed
// under a synthetic provider so it never sits plaintext on the agent row.
function endpointKeyProvider(agentName) {
  return `endpoint:${agentName}`;
}

// Closest agent name to what was typed, or null. Distance alone is too loose —
// "/ban" is within 2 of "bob" and "/remind" within 2 of "gemini" — so a shared
// opening also has to match. That keeps other bots' commands from drawing a
// reply while still catching real typos like "/cluade" or "/justin.ahn".
function suggestAgentName(userId, attempted) {
  const typed = String(attempted ?? '').toLowerCase();
  if (!typed) return null;
  return listAgents(userId)
    .map((a) => ({ name: a.agent_name, d: editDistance(typed, a.agent_name) }))
    .filter((x) => {
      const prefix = Math.min(2, x.name.length);
      return x.d <= 2 && typed.slice(0, prefix) === x.name.slice(0, prefix);
    })
    .sort((a, b) => a.d - b.d)[0]?.name ?? null;
}

// Levenshtein — used only to catch a mistyped agent name before it falls
// through to the chat provider and gets answered by the wrong thing.
function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      last = tmp;
    }
  }
  return prev[b.length];
}

// One-time migration of a pre-agent Minds connection into an agent, so anyone
// already connected keeps that conversation instead of silently starting over.
// Done in JS rather than SQL so it uses the real slugger — names like
// "justin.quidli" need the dot stripped or the resulting command is unreachable.
// mind_id is NOT required: it was added by a later ALTER, so older connections
// have alias + name with a NULL mind_id. The alias is what sends messages;
// mind_id is only needed to rotate it.
try {
  const legacy = db.prepare(`SELECT telegram_id, minds_name, minds_mind_id, minds_alias, minds_alias_created_at
    FROM user_keys WHERE minds_alias IS NOT NULL AND minds_name IS NOT NULL`).all();
  for (const row of legacy) {
    // Idempotency must NOT key on the alias: /minds re-registration legitimately
    // replaces it, after which an alias-based check stops matching and this
    // migration re-fires on every restart, creating _2, _3, _4… Bootstrapping is
    // only for users with no Minds agents at all.
    const already = db.prepare("SELECT 1 FROM user_agents WHERE user_id = ? AND kind = 'minds' LIMIT 1")
      .get(String(row.telegram_id));
    if (already) continue;
    let name = normalizeAgentName(row.minds_name) || `mind_${String(row.telegram_id).slice(-4)}`;
    // Don't shadow a stock agent, one of its aliases, or a bot command — a Mind
    // named "Hermes" must not quietly take over /hermes.
    if (STOCK_AGENTS[name] || AGENT_NAME_ALIASES[name] || RESERVED_AGENT_NAMES.has(name)) {
      name = `${name}_mind`.slice(0, 32);
    }
    let unique = name, n = 2;
    while (db.prepare('SELECT 1 FROM user_agents WHERE user_id = ? AND agent_name = ?')
      .get(String(row.telegram_id), unique)) unique = `${name}_${n++}`.slice(0, 32);
    db.prepare(`INSERT OR IGNORE INTO user_agents
        (user_id, agent_name, kind, mind_id, alias, alias_at, description)
      VALUES (?, ?, 'minds', ?, ?, ?, ?)`)
      .run(String(row.telegram_id), unique, row.minds_mind_id ?? null,
           row.minds_alias, row.minds_alias_created_at ?? null, row.minds_name);
    console.log(`[migrate] Mind "${row.minds_name}" → /${unique} for ${row.telegram_id}`);
  }
} catch (err) {
  console.error('[migrate] Minds → agents failed (non-fatal):', err.message);
}

// Switching providers always resets the model (null unless a specific model was
// named) and clears any agent default — "switch to claude" means claude, not
// "claude, but still routed through tim".
function setChannelProvider(contextId, provider, model = null) {
  db.prepare(`INSERT INTO chat_settings (context_id, provider, model, agent_name, updated_at)
    VALUES (?, ?, ?, NULL, unixepoch())
    ON CONFLICT(context_id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
      agent_name = NULL, updated_at = unixepoch()`)
    .run(String(contextId), provider, model);
}

// "switch to tim" — unprefixed messages go to that agent until you switch away.
// Scoped per (chat, user): agents are owned per-user, so in a group your default
// is yours. A chat-wide value would mean one member's message resolves against
// their own agents and wipes everyone else's.
function setChannelAgent(contextId, userId, agentName) {
  if (!agentName) {
    db.prepare('DELETE FROM chat_user_agent WHERE context_id = ? AND user_id = ?')
      .run(String(contextId), String(userId));
    return;
  }
  db.prepare(`INSERT INTO chat_user_agent (context_id, user_id, agent_name, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(context_id, user_id) DO UPDATE SET agent_name = excluded.agent_name,
      updated_at = unixepoch()`)
    .run(String(contextId), String(userId), agentName);
}

function getChannelAgentName(contextId, userId) {
  return db.prepare('SELECT agent_name FROM chat_user_agent WHERE context_id = ? AND user_id = ?')
    .get(String(contextId), String(userId))?.agent_name ?? null;
}

// Only consulted when detectProviderSwitch found nothing, so every existing
// phrase ("switch to claude", "switch to kimi") keeps its current meaning.
function detectAgentSwitch(text, userId) {
  const m = String(text).toLowerCase().match(/^(?:switch|change|use|swap)\s+(?:to\s+)?\/?([a-z0-9_]{1,32})$/);
  if (!m) return null;
  const agent = getAgent(userId, m[1]);
  return agent ? agent.agent_name : null;
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

// ── Shared chat digest ────────────────────────────────────────────────────────
// Each agent keeps its own conversation, which is what makes them feel separate —
// but it also means one can't answer "what did I just send?" or "are you the same
// as above?". This is a short, read-only view of recent turns in the chat, handed
// to agents as context only. Deliberately in memory and deliberately small: it's
// recent context, not history, and it must never dominate the actual message.
const chatDigests = new Map();
const DIGEST_TURNS = 6;
const DIGEST_CHARS = 220;

function recordDigest(contextId, who, text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const log = chatDigests.get(String(contextId)) ?? [];
  log.push({ who, text: clean.slice(0, DIGEST_CHARS) });
  if (log.length > DIGEST_TURNS) log.splice(0, log.length - DIGEST_TURNS);
  chatDigests.set(String(contextId), log);
}

// Everything except the turn being answered right now — an agent shouldn't see
// its own prompt twice.
function buildDigest(contextId, excludeLast = true) {
  const log = chatDigests.get(String(contextId)) ?? [];
  const rows = excludeLast ? log.slice(0, -1) : log;
  if (rows.length === 0) return '';
  return '[Recent messages in this chat, for context only — these were not addressed to you:]\n'
    + rows.map((r) => `${r.who}: ${r.text}`).join('\n');
}

// Hard bound on tool round-trips per user message. Without this the provider loops
// are `while (true)` and a model that keeps emitting tool calls never terminates —
// which matters because the MODEL mints each quidli_drop idempotencyKey (see system
// prompt), so a runaway loop would issue repeated *distinct* transfers, not retries.
// Longest legitimate chain is ~15 (resolve_telegram_username → up to 10 lookup
// retries → drop), so 25 leaves headroom.
const MAX_TOOL_ROUNDS = 25;

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

// ── Quidli Connect over MCP ───────────────────────────────────────────────────
// Tools here are discovered from mcp.connect.quid.li rather than hand-written,
// so new Connect capabilities appear without a code change. The allowlist is
// deliberate: connect_lookup / connect_drop / connect_scores_* duplicate the
// hardcoded quidli_* tools below, and offering both would leave the model
// choosing between two tools that do the same thing.
//
// The server is stateless and reads x-api-key per request, so each call is made
// with the *sender's* key — same per-user model as the REST path.
const MCP_URL = process.env.CONNECT_MCP_URL || 'https://mcp.connect.quid.li/';
const MCP_TOOL_ALLOWLIST = new Set(['connect_drop_balance']);
const mcpToolNames = new Set();

// Plain JSON-RPC over POST rather than the MCP SDK. The server is stateless —
// it builds a fresh transport per request and needs no initialize handshake, so
// tools/list and tools/call work as one-shot POSTs. The SDK's Streamable HTTP
// client hangs against it (it negotiates a session this server never issues),
// and skipping it also avoids 85 dependencies for four lines of protocol.
async function mcpRpc(method, params, apiKey, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? {} }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || `MCP ${method} error`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function mcpCallTool(name, args, apiKey) {
  const res = await mcpRpc('tools/call', { name, arguments: args ?? {} }, apiKey);
  const text = (res?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (res?.isError) throw new Error(text || 'MCP tool error');
  return text || JSON.stringify(res?.structuredContent ?? {});
}

// Discovered once at startup using the host key — reads schemas only, no side
// effects. If Connect's MCP is unreachable the bot starts normally with the
// hardcoded tools; these are additive, so nothing existing depends on them.
async function registerMcpTools() {
  if (!QUIDLI_API_KEY) return;
  try {
    const discovered = await mcpRpc('tools/list', {}, QUIDLI_API_KEY);
    for (const t of discovered?.tools ?? []) {
      if (!MCP_TOOL_ALLOWLIST.has(t.name)) continue;
      tools.push({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema });
      mcpToolNames.add(t.name);
    }
    console.log(`   Connect MCP: ${mcpToolNames.size ? [...mcpToolNames].join(', ') : 'no allowlisted tools found'}`);
  } catch (err) {
    console.error('[mcp] tool discovery failed, continuing without it:', err.message);
  }
}

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

  // Tools discovered from Connect's MCP. Called with the sender's own key, so
  // the per-user model is identical to the REST path — the owner falls back to
  // the host key exactly as drops do.
  if (mcpToolNames.has(name)) {
    const isOwner = BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID);
    const keyToUse = senderApiKey || (isOwner ? QUIDLI_API_KEY : null);
    if (!keyToUse) {
      return 'Error: you need to connect your own Quidli account first — DM me /connect <your-api-key> (get one at connect.quid.li).';
    }
    return await mcpCallTool(name, input, keyToUse);
  }

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

async function getOpenAIClient(userApiKey, baseURL, headers) {
  const key = userApiKey || OPENAI_API_KEY;
  if (!key) throw new Error('No OpenAI API key available. DM me /llm openai <key> to connect your own.');
  const { default: OpenAI } = await import('openai');
  return new OpenAI({
    apiKey: key,
    ...(baseURL ? { baseURL } : {}),
    ...(headers ? { defaultHeaders: headers } : {}),
  });
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

  let rounds = 0;
  while (true) {
    if (++rounds > MAX_TOOL_ROUNDS) {
      console.warn(`[anthropic] hit MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) in ${contextId} — stopping`);
      accumulated += `\n\n⚠️ Stopped after ${MAX_TOOL_ROUNDS} tool steps without finishing. Nothing further was run — try a simpler request.`;
      break;
    }
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

  let rounds = 0;
  while (true) {
    if (++rounds > MAX_TOOL_ROUNDS) {
      console.warn(`[gemini] hit MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) in ${contextId} — stopping`);
      accumulated += `\n\n⚠️ Stopped after ${MAX_TOOL_ROUNDS} tool steps without finishing. Nothing further was run — try a simpler request.`;
      break;
    }
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

async function runOpenAILoop(contextId, contextualText, editor, toolCtx, userLlmKey, { baseURL, model, headers } = {}) {
  const openai = await getOpenAIClient(userLlmKey, baseURL, headers);
  const modelToUse = model || OPENAI_MODEL;
  console.log(`[api-call] openai-compatible model="${modelToUse}" baseURL="${baseURL || 'api.openai.com (default)'}" usingUserKey=${!!userLlmKey}`);
  const history = getOpenAIHistory(contextId);
  history.push({ role: 'user', content: contextualText });
  let messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  let accumulated = '';

  let rounds = 0;
  while (true) {
    if (++rounds > MAX_TOOL_ROUNDS) {
      console.warn(`[openai-compatible] hit MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) in ${contextId} — stopping`);
      accumulated += `\n\n⚠️ Stopped after ${MAX_TOOL_ROUNDS} tool steps without finishing. Nothing further was run — try a simpler request.`;
      break;
    }
    const response = await openai.chat.completions.create({ model: modelToUse, messages, tools: getOpenAITools(), tool_choice: 'auto' });
    const choice = response.choices[0];
    const msg = choice.message;

    if (msg.content) { accumulated += msg.content; editor.update(accumulated || 'Thinking…'); }

    // Act on tool calls whenever they're present, regardless of finish_reason — some
    // OpenAI-compatible providers return tool_calls labelled 'stop', and requiring
    // 'tool_calls' would silently skip execution (bot replies, tool never runs).
    // Exception: 'length' means the response was cut off by the token limit, so the
    // arguments JSON may be half-written — never execute a truncated tool call.
    if (!msg.tool_calls?.length) break;
    if (choice.finish_reason === 'length') {
      console.warn(`[openai-compatible] truncated response with tool_calls in ${contextId} — not executing`);
      accumulated += '\n\n⚠️ The model\'s response was cut off mid-request, so nothing was run. Please try again.';
      break;
    }

    messages = [...messages, msg];
    editor.update((accumulated || 'Thinking…') + '\nLooking up…');

    const toolResults = await Promise.all(msg.tool_calls.map(async (tc) => {
      // A parse failure must NOT fall through to runTool with {} — an argument-less
      // quidli_drop is a call we never want to make. Report it back as a tool error
      // so the model can retry with well-formed arguments.
      let args;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        console.error(`[tool] malformed arguments for ${tc.function.name}: ${String(tc.function.arguments).slice(0, 200)}`);
        return { role: 'tool', tool_call_id: tc.id, content: 'Error: arguments were not valid JSON. Re-issue the call with well-formed JSON arguments.' };
      }
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

// Takes the agent to run rather than resolving a single stored Mind, so several
// Minds can be addressed independently. Each agent owns its own alias, which is
// what keeps their conversations separate.
async function runMindsBackground(contextId, text, chatId, pendingMsgId, senderId, agent, ownerTag) {
  const apiKey = getMindsBuilderKey(senderId);
  // The alias is what sends — mind_id is only needed to rotate, and older
  // connections legitimately don't have one.
  if (!apiKey || !agent?.alias) {
    await tg.telegram.editMessageText(chatId, pendingMsgId, null,
      '⚠️ You need to connect your Minds agent.\nDM me /minds <builder-api-key> to connect.\nGet a Builder API key at https://build.hellominds.ai/console'
    ).catch(() => {});
    return;
  }

  const mindName = agent.description || agent.agent_name;
  let alias = agent.alias;

  // Rotate alias if older than 4 hours to prevent Minds falling back to email.
  // Rotation starts a fresh thread on the Minds side — a constraint of theirs,
  // not a choice of ours.
  if (agent.mind_id && agent.alias_at) {
    const ageS = Math.floor(Date.now() / 1000) - agent.alias_at;
    if (ageS > MINDS_ALIAS_MAX_AGE_S) {
      try {
        const rotateClient = createMindsClient({ builderApiKey: apiKey });
        const newAlias = mintMindsAlias(senderId);
        await rotateClient.ensureConversation(newAlias, agent.mind_id);
        upsertAgent(senderId, agent.agent_name, { alias: newAlias, alias_at: Math.floor(Date.now() / 1000) });
        alias = newAlias;
        console.log(`[minds] Rotated alias for ${senderId}/${agent.agent_name} → ${newAlias}`);
      } catch (err) {
        console.error('[minds-rotate] failed:', err.message);
        // Continue with old alias rather than failing
      }
    }
  }
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

    // Same shape as the LLM path's label, so a renamed agent still reads clearly:
    // "tim · Minds (justinahn)" rather than losing the name you actually use.
    const shownName = ownerTag || agent.agent_name;
    const label = mindName && mindName !== agent.agent_name
      ? `${shownName} · Minds (${mindName})`
      : `${shownName} · Minds`;
    // Digest is keyed on the chat, not the agent's history key.
    recordDigest(String(chatId), `/${ownerTag || agent.agent_name}`, responseText);
    const finalText = `${responseText}\n— ${label}`;
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

// A message containing an API key otherwise sits in Telegram history forever.
// Bots may delete incoming messages in private chats, so remove it once parsed.
async function scrubCredentialMessage(ctx) {
  try {
    await ctx.deleteMessage();
    return true;
  } catch {
    return false; // >48h old, or permissions changed — fall back to telling the user
  }
}

const scrubNote = (scrubbed) => scrubbed
  ? '\n\n🧹 I deleted your message so the key isn\'t left in this chat.'
  : '\n\n⚠️ Couldn\'t delete your message — delete it yourself so the key isn\'t left in this chat.';

tg.command('connect', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const apiKey = ctx.message.text.replace('/connect', '').trim();
  if (!apiKey) {
    return ctx.reply('Usage: /connect <your-api-key>\nGet a key at https://connect.quid.li');
  }
  setUserApiKey(ctx.from.id, apiKey);
  const scrubbed = await scrubCredentialMessage(ctx);
  ctx.reply(
    '✅ Connected! Drops will now use your Smart Send wallet.\n\n' +
    '⚠️ Your API key is stored encrypted and only has access to your Smart Send balance — not your main wallet. ' +
    'DM /revoke anytime to disconnect.' + scrubNote(scrubbed)
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
  const apiKey = ctx.message.text.replace('/minds', '').trim().split(/\s+/)[0];

  if (!apiKey) {
    return ctx.reply(
      'Usage: /minds <builder-api-key>\n\n' +
      'Every enabled Mind on your account becomes its own command, so you can talk to ' +
      'them separately without switching.\n\n' +
      'Get a Builder API key at https://build.hellominds.ai/console'
    );
  }

  try {
    const client = createMindsClient({ builderApiKey: apiKey });
    const minds = await client.listMinds();
    const enabled = minds.filter((m) => m.isEnabled);

    if (enabled.length === 0) {
      return ctx.reply('❌ No enabled Minds found on your account. Visit https://build.hellominds.ai to set one up.');
    }

    // Keep the builder key where it already lives — one key covers every Mind.
    setUserMindsBuilderKey(ctx.from.id, apiKey);

    // Register each enabled Mind as its own agent with its own conversation alias.
    const registered = [];
    const skipped = [];
    const taken = new Set(listAgents(ctx.from.id).map((a) => a.agent_name));

    for (const mind of enabled) {
      let name = normalizeAgentName(mind.name);
      if (!name) name = `mind_${String(mind.mindId).slice(0, 6).toLowerCase()}`;
      // Don't shadow a bot command, a stock agent, or one of its aliases.
      if (STOCK_AGENTS[name] || AGENT_NAME_ALIASES[name] || RESERVED_AGENT_NAMES.has(name)) {
        name = `${name}_mind`.slice(0, 32);
      }

      // Match this Mind to an agent we already have: by mind_id normally, but
      // also by name when mind_id is NULL — that's a migrated pre-agent Mind,
      // and adopting it keeps its conversation instead of orphaning the alias.
      const mine = listAgents(ctx.from.id).filter((a) => a.kind === 'minds');
      const already = mine.find((a) => a.mind_id === mind.mindId)
        ?? mine.find((a) => !a.mind_id && a.agent_name === name);
      if (already) name = already.agent_name;

      if (!already && taken.has(name)) {
        let n = 2;
        while (taken.has(`${name}_${n}`.slice(0, 32))) n++;
        name = `${name}_${n}`.slice(0, 32);
      }

      const alias = already?.alias ?? mintMindsAlias(ctx.from.id);
      try {
        if (!already?.alias) await client.ensureConversation(alias, mind.mindId);
      } catch (err) {
        skipped.push(`${mind.name} — ${err.message.slice(0, 60)}`);
        continue;
      }

      upsertAgent(ctx.from.id, name, {
        kind: 'minds',
        mind_id: mind.mindId,
        alias,
        alias_at: already?.alias_at ?? Math.floor(Date.now() / 1000),
        description: mind.name,
      });
      taken.add(name);
      registered.push({ name, label: mind.name });
    }

    const disabled = minds.filter((m) => !m.isEnabled);
    const scrubbed = await scrubCredentialMessage(ctx);
    await refreshAgentCommands(ctx);

    const lines = registered.map((r) => `/${r.name} — ${r.label}`).join('\n');
    await ctx.reply(
      `✅ Registered ${registered.length} Mind${registered.length === 1 ? '' : 's'}:\n\n${lines}\n\n` +
      (disabled.length ? `Skipped ${disabled.length} disabled: ${disabled.map((m) => m.name).join(', ')}\n` : '') +
      (skipped.length ? `⚠️ Couldn't connect: ${skipped.join('; ')}\n` : '') +
      `\nTalk to one by name, e.g. /${registered[0]?.name ?? 'yourmind'} what's on today\n` +
      'Rename with /agent rename <old> <new> · see all with /agents' +
      scrubNote(scrubbed)
    );
  } catch (err) {
    ctx.reply(`❌ Failed to connect: ${err.message}`);
  }
});

tg.command('minds_remove', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const removed = db.prepare("DELETE FROM user_agents WHERE user_id = ? AND kind = 'minds'")
    .run(String(ctx.from.id)).changes ?? 0;
  deleteUserMindsCredentials(ctx.from.id);
  await refreshAgentCommands(ctx);
  ctx.reply(`🗑️ Your Minds credentials have been removed${removed ? `, along with ${removed} Mind agent${removed === 1 ? '' : 's'}` : ''}.`);
});

tg.command('agents', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const agents = listAgents(ctx.from.id);
  const mine = agents.filter((a) => !a.is_stock);
  const stock = agents.filter((a) => a.is_stock);

  const current = getChannelAgentName(ctx.chat.id, ctx.from.id);
  const fmt = (a) => `/${a.agent_name} — ${describeAgent(a)}`
    + (a.agent_name === current ? '  ← messages go here' : '');
  const provider = getChannelProvider(String(ctx.chat.id));
  await ctx.reply(
    (mine.length ? `Your agents:\n${mine.map(fmt).join('\n')}\n\n` : 'You haven\'t created any agents yet.\n\n') +
    `Also available:\n${stock.map(fmt).join('\n')}\n\n` +
    (current
      ? `Unprefixed messages go to /${current}. Say "switch to claude" to go back to a model.\n\n`
      : `Unprefixed messages go to ${provider}. Say "switch to <name>" to send them to an agent instead.\n\n`) +
    'Talk to one by name, e.g. /' + (mine[0]?.agent_name ?? 'claude') + ' hello\n' +
    'Create: /agent new <name> · Connect your Minds: /minds <key>'
  );
});

tg.command('agent', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const parts = ctx.message.text.replace(/^\/agent(@\S+)?/, '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();
  const usage =
    'Manage your agents:\n\n' +
    '/agent new <name> — create one, pick what it runs on\n' +
    '/agent model <name> <model> — change its model\n' +
    '/agent rename <old> <new>\n' +
    '/agent delete <name>\n' +
    '/agent endpoint <name> <url> <key> — point at your own agent server\n\n' +
    'See them all with /agents';

  if (!sub) return ctx.reply(usage);

  // ── create ────────────────────────────────────────────────────────────────
  if (sub === 'new') {
    const name = normalizeAgentName(parts[1]);
    if (!name) return ctx.reply('Give it a name: /agent new bob');
    if (RESERVED_AGENT_NAMES.has(name)) return ctx.reply(`"${name}" is a bot command — pick another name.`);
    if (getAgent(ctx.from.id, name)) {
      return ctx.reply(`/${name} already exists. Change what it runs on with /agent model ${name} <model>, or /agent delete ${name} first.`);
    }
    if (name !== String(parts[1]).toLowerCase()) {
      await ctx.reply(`Names become commands, so I'll use /${name}.`);
    }
    // Only offer providers that will actually work: the user has their own key,
    // or they're allowed the host's AND the host has one configured. Offering a
    // provider whose key is blank produces an agent that fails on first use.
    const canHost = mayUseHostKey(ctx.from.id, ctx.from.username);
    const options = ['anthropic', 'gemini', 'openai', 'hermes', 'openrouter'].filter((p) =>
      getUserLlmKeyFor(ctx.from.id, p) || (canHost && hostKeyFor(p)));
    if (options.length === 0) {
      return ctx.reply(
        'You don\'t have any usable providers yet. Connect one first:\n' +
        '/llm hermes <key> — portal.nousresearch.com (has a free tier)\n' +
        '/llm anthropic <key> — console.anthropic.com'
      );
    }
    return ctx.reply(`What should /${name} run on?`, {
      reply_markup: {
        inline_keyboard: options.map((p) => [{ text: providerLabel(p), callback_data: `agentnew:${name}:${p}` }]),
      },
    });
  }

  // ── change model ──────────────────────────────────────────────────────────
  if (sub === 'model') {
    const name = normalizeAgentName(parts[1]);
    const model = parts.slice(2).join(' ').trim();
    const agent = name && getAgent(ctx.from.id, name);
    if (!agent) return ctx.reply(`No agent called /${name ?? '?'}. See /agents`);
    if (agent.kind === 'minds') return ctx.reply('Minds agents get their model from Minds — change it at build.hellominds.ai.');
    if (!model) return ctx.reply(`Usage: /agent model ${name} <model>\nCurrently: ${describeAgent(agent)}`);
    upsertAgent(ctx.from.id, name, { kind: agent.kind, provider: agent.provider, base_url: agent.base_url, model });
    await refreshAgentCommands(ctx);
    return ctx.reply(`✅ /${name} now runs ${model}.`);
  }

  // ── rename ────────────────────────────────────────────────────────────────
  if (sub === 'rename') {
    const from = normalizeAgentName(parts[1]);
    const to = normalizeAgentName(parts[2]);
    if (!from || !to) return ctx.reply('Usage: /agent rename <old> <new>');
    const agent = from && getAgent(ctx.from.id, from);
    if (!agent || agent.is_stock) return ctx.reply(`No agent of yours called /${from}. See /agents`);
    if (RESERVED_AGENT_NAMES.has(to)) return ctx.reply(`"${to}" is a bot command — pick another name.`);
    if (getAgent(ctx.from.id, to)) return ctx.reply(`/${to} is already taken.`);
    renameAgent(ctx.from.id, from, to);
    await refreshAgentCommands(ctx);
    return ctx.reply(`✅ /${from} is now /${to}. Its conversation carried over.`);
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (sub === 'delete') {
    const name = normalizeAgentName(parts[1]);
    const agent = name && getAgent(ctx.from.id, name);
    if (!agent || agent.is_stock) return ctx.reply(`No agent of yours called /${name ?? '?'}. See /agents`);
    deleteAgent(ctx.from.id, name);
    clearAgentHistory(String(ctx.chat.id), name);
    await refreshAgentCommands(ctx);
    return ctx.reply(`🗑️ /${name} deleted.`);
  }

  // ── point at your own agent server ────────────────────────────────────────
  if (sub === 'endpoint') {
    const name = normalizeAgentName(parts[1]);
    const url = parts[2];
    const key = parts[3];
    if (!name || !url || !key) {
      return ctx.reply(
        'Usage: /agent endpoint <name> <url> <key>\n\n' +
        'Points an agent at any OpenAI-compatible agent server — e.g. a Hermes API server:\n' +
        '/agent endpoint rig https://your-host:8642/v1 <API_SERVER_KEY>\n\n' +
        'Your message is deleted straight after so the key isn\'t left in this chat.'
      );
    }
    if (RESERVED_AGENT_NAMES.has(name)) return ctx.reply(`"${name}" is a bot command — pick another name.`);
    const twin = listAgents(ctx.from.id).find((a) => a.base_url === url && a.agent_name !== name);
    // The bearer token goes through the same encrypted store as every other key —
    // never into user_agents, which is plaintext. Only the (non-secret) session
    // key lives on the agent row.
    setUserLlmKey(ctx.from.id, endpointKeyProvider(name), key, null);
    upsertAgent(ctx.from.id, name, {
      kind: 'llm', provider: 'endpoint', base_url: url, model: 'hermes-agent',
      headers: JSON.stringify({ 'X-Hermes-Session-Key': getAgent(ctx.from.id, name)?.headers
        ? JSON.parse(getAgent(ctx.from.id, name).headers)['X-Hermes-Session-Key']
        : mintSessionKey(ctx.from.id) }),
    });
    const scrubbed = await scrubCredentialMessage(ctx);
    await refreshAgentCommands(ctx);
    return ctx.reply(
      `✅ /${name} points at your agent server.` +
      (twin ? `\n\n⚠️ Same URL as /${twin.agent_name} — that's the same agent with a separate memory, not a second one. Run another profile for a genuinely separate agent.` : '') +
      scrubNote(scrubbed)
    );
  }

  return ctx.reply(usage);
});

// Button press from `/agent new <name>` — picks what the agent runs on.
tg.action(/^agentnew:([a-z0-9_]{1,32}):([a-z]+)$/, async (ctx) => {
  const [, name, provider] = ctx.match;
  try {
    if (getAgent(ctx.from.id, name)?.is_stock === 0) {
      await ctx.answerCbQuery('Already exists');
      return;
    }
    upsertAgent(ctx.from.id, name, { kind: 'llm', provider, model: null });
    await ctx.answerCbQuery('Created');
    await refreshAgentCommands(ctx);
    const agent = getAgent(ctx.from.id, name);
    await ctx.editMessageText(
      `✅ /${name} is ready — ${describeAgent(agent)}.\n\n` +
      `Talk to it: /${name} hello\n` +
      `Change its model: /agent model ${name} <model>`
    );
  } catch (err) {
    console.error('[agentnew] failed:', err.message);
    await ctx.answerCbQuery('Something went wrong').catch(() => {});
  }
});

tg.command('llm', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const parts = ctx.message.text.replace('/llm', '').trim().split(/\s+/);
  // 'nous' is the name users see (/nous, "switch to nous"); 'hermes' remains the
  // stored id and keeps working for anyone who learned it that way.
  const provider = ({ nous: 'hermes' })[parts[0]?.toLowerCase()] ?? parts[0]?.toLowerCase();
  const apiKey = parts[1];
  const model = parts[2] || null; // optional, used for openrouter and nous

  if (!provider || !apiKey) {
    return ctx.reply(
      'Usage: /llm <provider> <api-key>\n\n' +
      'Providers:\n' +
      '  anthropic  — from console.anthropic.com\n' +
      '  gemini     — from aistudio.google.com/apikey\n' +
      '  openai     — from platform.openai.com\n' +
      '  openrouter — from openrouter.ai (access 100+ models)\n' +
      '  nous       — Nous Portal, from portal.nousresearch.com (API keys)\n\n' +
      'For OpenRouter and Nous Portal you can also name a model:\n' +
      '  /llm openrouter <key> [model]\n' +
      '  Example: /llm openrouter sk-or-... meta-llama/llama-3-70b-instruct\n' +
      '  Default model: openai/gpt-4o\n' +
      '  /llm nous <key> [model]\n' +
      '  Example: /llm nous sk-... tencent/hy3:free  (free tier)\n' +
      '  Nous Portal proxies 200+ models — see portal.nousresearch.com/info\n\n' +
      'Your key is stored encrypted and used instead of the host key. DM /llm_remove to disconnect.'
    );
  }

  if (!['anthropic', 'gemini', 'openai', 'openrouter', 'hermes'].includes(provider)) {
    return ctx.reply('Unknown provider. Use: anthropic, gemini, openai, openrouter, or nous');
  }

  setUserLlmKey(ctx.from.id, provider, apiKey, model);
  const modelNote = provider === 'openrouter' ? ` (model: ${model || 'openai/gpt-4o'})`
    : provider === 'hermes' ? ` (model: ${model || NOUS_MODEL})`
    : '';
  const shown = provider === 'hermes' ? 'nous' : provider;
  ctx.reply(
    `✅ Connected your ${providerLabel(provider)} key${modelNote}.\n\n` +
    `This applies wherever a chat is running on ${providerLabel(provider)}. If a chat is on a different ` +
    `provider, say "switch to ${shown}" there first — then it'll run on your own credits.\n\n` +
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

  // …or when the sender addresses one of their own agents by name. Checked on
  // the raw text before mention-stripping, and resolved against the SENDER, so
  // in a group your /tim is yours and nobody else can invoke it.
  const addressedName = text.match(/^\/([a-z0-9_]{1,32})(?:@\S+)?(?:[\s,:;]|$)/i)?.[1];
  const addressesOwnAgent = !!(addressedName && getAgent(senderId, addressedName));

  // Track everyone who messages the bot — in groups (so "everyone" drops work)
  // and in DMs (so resolve_telegram_username can find anyone who's ever messaged the bot directly)
  recordChatMember(chatId, senderId, username);

  if (!isPrivate && !isMentioned && !isReplyToBot && !addressesOwnAgent) {
    // An unrecognised /command in a group is usually another bot's, so silence is
    // right. But if it's close to one of THIS sender's own agents it's a typo —
    // and staying silent there just looks like the bot is broken. Note names can
    // only be [a-z0-9_], so "/justin.ahn" never resolves however it's punctuated.
    const attempted = text.match(/^\/([^\s@]{1,40})/)?.[1]?.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const near = attempted && suggestAgentName(senderId, attempted);
    if (near) {
      await ctx.reply(`No agent called /${attempted}. Did you mean /${near}?`).catch(() => {});
      return;
    }
    // Still check watchers even if not mentioned
    await checkWatchers(chatId, senderId, username, text).catch((err) => console.error('[watcher] error:', err.message));
    return;
  }

  // Skip DM commands (handled by command handlers above)
  if (isPrivate && (text.startsWith('/connect') || text.startsWith('/revoke') || text.startsWith('/minds') || text.startsWith('/llm')
      || text.startsWith('/agent') || text.startsWith('/agents'))) {
    return;
  }

  // Access control
  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(senderId)) {
    await ctx.reply('You are not authorized to use this bot.').catch(() => {});
    return;
  }

  // Owner check — used for BYOLLM exemption and wallet note below
  const isOwner = BOT_OWNER_ID && String(senderId) === String(BOT_OWNER_ID);

  // Strip bot mention from text
  const cleanText = botUsername
    ? text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim()
    : text.trim();

  if (!cleanText) {
    await ctx.reply('What can I help you with?').catch(() => {});
    return;
  }

  const contextId = String(chatId);

  // ── Agent addressing ─────────────────────────────────────────────────────────
  // A message starting with /name, where name is one of THIS SENDER's agents,
  // goes to that agent. Anything else — including /foo that isn't an agent —
  // falls through to exactly the behaviour that existed before agents.
  // Works in groups: agents are owned per-user, so your /tim is yours, runs on
  // your key, and nobody else in the room can invoke it.
  let agent = null;
  let agentText = cleanText;
  {
    // Separator after the name may be whitespace or punctuation — "/bob, what's up"
    // and "/bob: hi" are natural to type, and previously matched nothing at all,
    // which sent the message to the chat provider without any warning.
    // Hyphen is deliberately excluded so "/tim-bob" stays a single unknown name.
    const m = cleanText.match(/^\/([a-z0-9_]{1,32})(?:@\S+)?(?:[\s,:;]+([\s\S]*))?$/i);
    const candidate = m && getAgent(senderId, m[1]);
    // A mistyped agent name must not silently fall through to the chat provider —
    // you'd get a confident answer from something you didn't address.
    if (m && !candidate) {
      const near = suggestAgentName(senderId, m[1]);
      if (near) {
        await ctx.reply(`No agent called /${m[1]}. Did you mean /${near}?`).catch(() => {});
        return;
      }
    }
    if (candidate) {
      agent = candidate;
      // First agent use in a group: tell the room what agents can see, once.
      if (!isPrivate && claimAgentNotice(contextId)) {
        await ctx.reply(
          'ℹ️ Agents are now in use here. Each person\'s agent runs on their own API key, and ' +
          'agents can see recent messages *addressed to an agent* plus agents\' replies — ' +
          'ordinary chat in this group is not sent to them.'
        ).catch(() => {});
      }
      agentText = (m[2] ?? '').trim();
      if (!agentText) {
        // Naming an agent with nothing to say shows its card instead of burning a turn.
        await ctx.reply(
          `/${agent.agent_name} — ${describeAgent(agent)}\n\n` +
          `Talk to it: /${agent.agent_name} <message>` +
          (agent.is_stock ? '' : `\nRename: /agent rename ${agent.agent_name} <new>`)
        ).catch(() => {});
        return;
      }
      // Replying to a message while addressing an agent hands it the quote, so
      // you can pass one agent's answer to another without copy-pasting.
      const quoted = msg.reply_to_message?.text;
      if (quoted) agentText = `[quoting an earlier message]\n${quoted}\n\n${agentText}`;
    }
    // No explicit /name: fall back to the chat's default agent if one is set.
    // Resolved fresh each turn so a deleted or renamed agent can't strand the chat.
    if (!agent) {
      const fallback = getChannelAgentName(contextId, senderId);
      if (fallback) {
        const resolved = getAgent(senderId, fallback);
        if (resolved) agent = resolved;
        else setChannelAgent(contextId, senderId, null); // it was deleted — quietly revert
      }
    }
  }

  // ── Host-key protection ──────────────────────────────────────────────────────
  // The host's LLM keys are spendable only by the owner or explicitly authorized
  // handles. Everyone else must have their own key FOR THE PROVIDER IN USE — a
  // Gemini key must not unlock the host's Nous key. Checked before the switch is
  // applied, since switching changes the provider for everyone in the chat.
  // Providers outside HOST_KEY_PROVIDERS (openrouter, minds) are per-user already.
  // An addressed agent decides the provider; otherwise this is unchanged.
  // 'endpoint' agents carry their own key, so they never touch a host key.
  const activeProvider = agent
    ? (agent.kind === 'minds' ? 'minds' : agent.provider)
    : (detectProviderSwitch(cleanText) ?? getChannelProvider(contextId));
  // An OpenRouter key also counts for 'anthropic' — the branch below deliberately
  // routes Claude through OpenRouter on the user's own credits in that case.
  const hasOwnKeyForProvider = !!getUserLlmKeyFor(senderId, activeProvider)
    || (activeProvider === 'anthropic' && !!getUserLlmKeyFor(senderId, 'openrouter'));

  if (HOST_KEY_PROVIDERS.has(activeProvider)
      && !mayUseHostKey(senderId, username)
      && !hasOwnKeyForProvider) {
    const keySource = {
      anthropic: 'console.anthropic.com',
      gemini: 'aistudio.google.com/apikey',
      openai: 'platform.openai.com',
      hermes: 'portal.nousresearch.com',
    }[activeProvider] ?? '';
    await ctx.reply(
      `🔐 This chat runs on ${providerLabel(activeProvider)}, and only the owner (plus anyone they authorize) can use the host's key.\n\n` +
      `You have three options:\n\n` +
      `1️⃣ Use your own ${providerLabel(activeProvider)} key — DM me:\n` +
      `   /llm ${activeProvider} <key>\n` +
      `   Get one at ${keySource}\n\n` +
      '2️⃣ Use a different provider on your own key — DM me one of:\n' +
      '   /llm hermes <key> — Nous Portal, portal.nousresearch.com (has a free tier)\n' +
      '   /llm openrouter <key> — openrouter.ai\n' +
      '   /llm gemini <key> — aistudio.google.com/apikey\n' +
      '   /llm openai <key> — platform.openai.com\n' +
      '   ...then say "switch to nous" (or openrouter/gemini/openai) here.\n\n' +
      '3️⃣ Ask the bot owner to authorize you to use the host key.'
    ).catch(() => {});
    return;
  }

  // ── Agent switch ─────────────────────────────────────────────────────────────
  // Checked only after provider detection finds nothing, so "switch to hermes"
  // still means the provider and "switch to tim" means the agent.
  if (!agent && isPrivate && !detectProviderSwitch(cleanText)) {
    const target = detectAgentSwitch(cleanText, senderId);
    if (target) {
      setChannelAgent(contextId, senderId, target);
      const a = getAgent(senderId, target);
      await ctx.reply(
        `🔀 Messages here now go to /${target} — ${describeAgent(a)}.\n` +
        'Say "switch to claude" (or any provider) to go back.'
      ).catch(() => {});
      return;
    }
  }

  // ── Provider switch detection ────────────────────────────────────────────────
  // Skipped when an agent is addressed — "/bob switch to gemini" is a message
  // for bob, not an instruction to the bot.
  const switchTarget = agent ? null : detectProviderSwitch(cleanText);
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
    // Switching to a provider means the provider — drop only *your* agent
    // default, not everyone's, since the chat is shared but agents aren't.
    setChannelAgent(contextId, senderId, null);
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
  const pendingMsg = await ctx.reply(agent ? `${agent.agent_name} is thinking…` : 'Thinking…').catch((err) => {
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
  // Log this turn, then build the digest excluding it.
  // In a group "you" is ambiguous — name the speaker so agents can tell members apart.
  const speaker = isPrivate ? 'you' : `@${username}`;
  recordDigest(contextId, agent ? `${speaker} → /${agent.agent_name}` : speaker, agentText);
  const digest = agent ? buildDigest(contextId) : '';

  const contextualText = `${timeContext}\n${senderContext} ${walletNote}\n`
    + (digest ? `${digest}\n\n` : '')
    + agentText;

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

    if (agent) {
      // Agents run on their own history key, so each keeps its own thread.
      const aCtx = agentContextId(contextId, agent.agent_name);
      if (agent.kind === 'minds') {
        runMindsBackground(aCtx, contextualText, chatId, pendingMsg.message_id, senderId, agent,
          agentTag(agent, username, isPrivate))
          .catch((err) => console.error('[minds-bg] unhandled:', err.message));
        return;
      }
      // Same key precedence as the non-agent path: the user's own key, else the
      // host's if they're authorised. Only hermes needs this spelled out —
      // the anthropic/gemini/openai clients fall back to their own host key
      // internally, but getOpenAIClient would fall back to OPENAI_API_KEY, which
      // is the wrong credential for a custom baseURL.
      const ownKey = agent.base_url
        ? getUserLlmKeyFor(senderId, endpointKeyProvider(agent.agent_name))?.apiKey
        : getUserLlmKeyFor(senderId, agent.provider)?.apiKey;
      let key = ownKey ?? null;
      if (!key && agent.provider === 'hermes' && mayUseHostKey(senderId, username)) key = NOUS_API_KEY ?? null;

      if (!key && agent.provider === 'openrouter') {
        await editor.finalize(
          `🔐 /${agent.agent_name} runs on OpenRouter, which is bring-your-own-key.\n\n` +
          'DM me /llm openrouter <key> to connect one (openrouter.ai/keys).'
        );
        return;
      }
      if (!key && agent.base_url) {
        await editor.finalize(
          `⚠️ /${agent.agent_name} has no stored key. Re-add it with /agent endpoint ${agent.agent_name} <url> <key>.`
        );
        return;
      }
      if (!key && agent.provider === 'hermes') {
        await editor.finalize(
          `🔐 /${agent.agent_name} runs on Nous Portal and there's no key available to you.\n\n` +
          'DM me /llm hermes <key> to connect your own (portal.nousresearch.com), or ask the bot owner to authorize you.'
        );
        return;
      }
      let extraHeaders;
      try { extraHeaders = agent.headers ? JSON.parse(agent.headers) : undefined; } catch { extraHeaders = undefined; }

      if (agent.provider === 'gemini') {
        accumulated = await runGeminiLoop(aCtx, contextualText, editor, toolCtx, key);
      } else if (agent.provider === 'anthropic') {
        accumulated = await runAnthropicLoop(aCtx, contextualText, editor, toolCtx, key, agent.model || undefined);
      } else {
        accumulated = await runOpenAILoop(aCtx, contextualText, editor, toolCtx, key, {
          baseURL: agent.base_url
            || (agent.provider === 'hermes' ? NOUS_API_BASE_URL
              : agent.provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
              : undefined),
          model: agent.model || defaultModelForProvider(agent.provider) || undefined,
          headers: extraHeaders,
        });
      }
      modelLabel = `${agentTag(agent, username, isPrivate)} · ${describeAgent(agent)}`;
    } else if (effectiveProvider === 'gemini') {
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
      const hermesRow = getUserLlmKeyFor(senderId, 'hermes');
      const hermesKey = hermesRow?.apiKey || NOUS_API_KEY;
      if (!hermesKey) {
        await editor.finalize(
          '⚠️ This chat is in Hermes mode, but no NOUS_API_KEY is set in .env and you don\'t have a personal Hermes key connected.\n' +
          'DM me /llm hermes <key> to set up (portal.nousresearch.com), or say "switch to claude" to change modes.'
        );
        return;
      }
      // Same precedence as OpenRouter: chat-level override > user's stored model > host default
      const hermesModel = chModel || hermesRow?.model || NOUS_MODEL;
      accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, hermesKey, {
        baseURL: NOUS_API_BASE_URL,
        model: hermesModel,
      });
      modelLabel = hermesModel;
    } else if (effectiveProvider === 'minds') {
      // `switch to minds` stays exactly as it was for the user, but now resolves
      // through the agent registry rather than a separate stored credential —
      // one implementation, so Minds mode and /agentname can't drift apart.
      const creds = firstMindsAgent(senderId);
      const builderKey = getMindsBuilderKey(senderId);
      const mindName = creds?.description ?? 'unknown';

      // If this looks like a confirmation, re-fetch Minds history to check for a pending action.
      // Using getHistory instead of in-memory state so handoffs survive bot restarts.
      let handoffText = null;
      if (creds && builderKey && isPositiveConfirmation(cleanText)) {
        try {
          const mindsClient = createMindsClient({ builderApiKey: builderKey });
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
        // Minds itself is per-user, but executing a confirmed plan hands off to Claude —
        // which would otherwise fall back to the HOST's Anthropic key. Gate it the same way.
        if (!anthKey && !mayUseHostKey(senderId, username)) {
          await editor.finalize(
            '🔐 Executing this needs Claude, and you\'re not authorized to use the host\'s key.\n\n' +
            'DM me /llm anthropic <key> to connect your own, or ask the bot owner to authorize you.'
          );
          return;
        }
        accumulated = await runAnthropicLoop(contextId, handoffText, editor, toolCtx, anthKey?.apiKey ?? null);
        modelLabel = `${CLAUDE_MODEL} (via Minds)`;
      } else {
        runMindsBackground(contextId, contextualText, chatId, pendingMsg.message_id, senderId, creds)
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
    if (agent) recordDigest(contextId, `/${agentTag(agent, username, isPrivate)}`, accumulated);
    await editor.finalize(finalText);

  } catch (err) {
    console.error(`[${agent ? `agent:${agent.agent_name}` : provider}] error:`, err);
    // Roll back the unpaired user message on the SAME key the turn used —
    // an agent turn must not truncate the chat-level history, or vice versa.
    const rollbackId = agent ? agentContextId(contextId, agent.agent_name) : contextId;
    const rollbackProvider = agent ? agent.provider : provider;
    if (rollbackProvider === 'gemini') { const h = getGeminiHistory(rollbackId); if (h.at(-1)?.role === 'user') h.pop(); }
    else if (rollbackProvider === 'anthropic') { const h = getAnthropicHistory(rollbackId); if (h.at(-1)?.role === 'user') h.pop(); }
    else if (agent || rollbackProvider === 'openai' || rollbackProvider === 'hermes') { const h = getOpenAIHistory(rollbackId); if (h.at(-1)?.role === 'user') h.pop(); }
    else { const h = getAnthropicHistory(rollbackId); if (h.at(-1)?.role === 'user') h.pop(); }
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
  if (NOUS_API_KEY) console.log(`   Nous Portal: ${NOUS_MODEL} ✓ (200+ models, per-user override with /llm nous <key> <model>)`);
  console.log(`   Minds: per-user keys (DM /minds <key> to register)`);
  console.log(`   Quidli: ${QUIDLI_API_KEY ? 'API key' : 'x402 payments'}`);
  console.log(`   Key storage: ${encKey ? 'encrypted (AES-256-GCM)' : '⚠️  plaintext — set MASTER_ENCRYPTION_KEY to encrypt'}`);
  loadPendingDrops();
  loadPendingClaims();
  // Additive and non-blocking — a failure here leaves the hardcoded tools intact.
  registerMcpTools();
});

process.once('SIGINT', () => tg.stop('SIGINT'));
process.once('SIGTERM', () => tg.stop('SIGTERM'));
