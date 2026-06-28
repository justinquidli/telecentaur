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
import { createMindsClient } from '@animocabrands/minds-client-lib';
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
  REQUIRE_USER_LLM_KEY = 'false', // Set to 'true' to require users to bring their own LLM key
} = process.env;

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
- Call quidli_drop DIRECTLY with social identities — you do NOT need to call quidli_lookup first. Quidli resolves identities internally.
- USDC on Base: chainId=8453, tokenContract=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 1 USDC = 1000000 amountInWeiPerRecipient (6 decimals).
- Always generate a fresh UUID for idempotencyKey.
- After success, always show the basescan URL: https://basescan.org/tx/<transferHash>
- If a recipient isn't in the registry, still attempt the drop — Quidli will hold it as a pending claim.
- Use EXACTLY one of "id" or "username" per recipient, never both.

## Looking up wallets (quidli_lookup)
Only call quidli_lookup when the user specifically asks for a wallet address. Do NOT call it before drops.

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
try { db.exec(`ALTER TABLE user_keys ADD COLUMN llm_provider TEXT`); } catch { }
try { db.exec(`ALTER TABLE user_keys ADD COLUMN llm_api_key TEXT`); } catch { }

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
  updated_at INTEGER DEFAULT (unixepoch())
)`);
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
  const row = db.prepare('SELECT minds_alias, minds_api_key, minds_name FROM user_keys WHERE telegram_id = ?').get(String(telegramId));
  if (!row?.minds_alias || !row?.minds_api_key) return null;
  return { alias: row.minds_alias, apiKey: decrypt(row.minds_api_key), name: row.minds_name ?? 'Minds' };
}

function setUserMindsCredentials(telegramId, apiKey, alias, mindName) {
  db.prepare(`INSERT INTO user_keys (telegram_id, minds_alias, minds_api_key, minds_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET minds_alias = excluded.minds_alias, minds_api_key = excluded.minds_api_key, minds_name = excluded.minds_name`)
    .run(String(telegramId), alias, encrypt(apiKey), mindName ?? null);
}

function deleteUserMindsCredentials(telegramId) {
  db.prepare('UPDATE user_keys SET minds_alias = NULL, minds_api_key = NULL, minds_name = NULL WHERE telegram_id = ?').run(String(telegramId));
}

function getUserLlmKey(telegramId) {
  const row = db.prepare('SELECT llm_provider, llm_api_key FROM user_keys WHERE telegram_id = ?').get(String(telegramId));
  if (!row?.llm_provider || !row?.llm_api_key) return null;
  return { provider: row.llm_provider, apiKey: decrypt(row.llm_api_key) };
}

function setUserLlmKey(telegramId, provider, apiKey) {
  db.prepare(`INSERT INTO user_keys (telegram_id, llm_provider, llm_api_key)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET llm_provider = excluded.llm_provider, llm_api_key = excluded.llm_api_key`)
    .run(String(telegramId), provider, encrypt(apiKey));
}

function deleteUserLlmKey(telegramId) {
  db.prepare('UPDATE user_keys SET llm_provider = NULL, llm_api_key = NULL WHERE telegram_id = ?').run(String(telegramId));
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

// ─── Provider switching ───────────────────────────────────────────────────────

function getChannelProvider(contextId) {
  const row = db.prepare('SELECT provider FROM chat_settings WHERE context_id = ?').get(String(contextId));
  return row?.provider ?? DEFAULT_LLM_PROVIDER;
}

function setChannelProvider(contextId, provider) {
  db.prepare(`INSERT INTO chat_settings (context_id, provider, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(context_id) DO UPDATE SET provider = excluded.provider, updated_at = unixepoch()`)
    .run(String(contextId), provider);
}

function detectProviderSwitch(text) {
  const lower = text.toLowerCase();
  if (/(switch|change|use|swap)\s+(to\s+)?(gemini|google)/.test(lower)) return 'gemini';
  if (/(switch|change|use|swap)\s+(to\s+)?(openai|gpt|chatgpt|open\s*ai)/.test(lower)) return 'openai';
  if (/(switch|change|use|swap)\s+(to\s+)?(claude|anthropic)/.test(lower)) return 'anthropic';
  if (/\bgemini\s+mode\b/.test(lower)) return 'gemini';
  if (/\bopenai\s+mode\b/.test(lower)) return 'openai';
  if (/\bclaude\s+mode\b/.test(lower)) return 'anthropic';
  if (/(switch|change|use|swap)\s+(to\s+)?minds/.test(lower)) return 'minds';
  if (/\bminds\s+mode\b/.test(lower)) return 'minds';
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

// ─── Minds handoff state ──────────────────────────────────────────────────────

const mindsLastResponse = new Map();

function mindsStateKey(contextId, senderId) {
  return `${contextId}:${senderId}`;
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
  if (data.status === 'completed') return data.results;
  if (data.status === 'processing' && data.pendingRequestId) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const followUp = await quidliFetch(`/lookup/follow-up/${data.pendingRequestId}`);
      const followData = await followUp.json();
      if (followData.status === 'completed') {
        const retry = await quidliFetch('/lookup', { method: 'POST', body: JSON.stringify({ recipients }) });
        const retryData = await retry.json();
        return retryData.results ?? [];
      }
    }
    throw new Error('Lookup timed out after processing');
  }
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
];

// Tracks basescan URLs produced during a turn so they're always shown
const _pendingBasescanUrls = [];

// ─── Tool runner ──────────────────────────────────────────────────────────────

async function runTool(name, input, { senderId, senderApiKey, currentChatId } = {}) {
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

async function getOpenAIClient(userApiKey) {
  const key = userApiKey || OPENAI_API_KEY;
  if (!key) throw new Error('No OpenAI API key available. DM me /llm openai <key> to connect your own.');
  const { default: OpenAI } = await import('openai');
  return new OpenAI({ apiKey: key });
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

async function runAnthropicLoop(contextId, contextualText, editor, toolCtx, userLlmKey) {
  const history = getAnthropicHistory(contextId);
  history.push({ role: 'user', content: contextualText });
  let messages = [...history];
  let accumulated = '';
  const client = getAnthropicClient(userLlmKey);

  while (true) {
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
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

async function runOpenAILoop(contextId, contextualText, editor, toolCtx, userLlmKey) {
  const openai = await getOpenAIClient(userLlmKey);
  const history = getOpenAIHistory(contextId);
  history.push({ role: 'user', content: contextualText });
  let messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  let accumulated = '';

  while (true) {
    const response = await openai.chat.completions.create({ model: OPENAI_MODEL, messages, tools: getOpenAITools(), tool_choice: 'auto' });
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

async function runMindsBackground(contextId, text, chatId, pendingMsgId, senderId, stateKey, mindName) {
  const creds = getUserMindsCredentials(senderId);
  if (!creds) {
    await tg.telegram.editMessageText(chatId, pendingMsgId, null,
      '⚠️ You need to connect your Minds agent.\nDM me /minds <builder-api-key> to connect.\nGet a Builder API key at https://build.hellominds.ai/console'
    ).catch(() => {});
    return;
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
      mindsLastResponse.set(stateKey, {
        text: responseText,
        isPendingAction: looksLikePendingAction(responseText),
      });
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
    setUserMindsCredentials(ctx.from.id, apiKey, userAlias, selectedMind.name);

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

  if (!provider || !apiKey) {
    return ctx.reply(
      'Usage: /llm <provider> <api-key>\n\n' +
      'Providers:\n' +
      '  anthropic — from console.anthropic.com\n' +
      '  gemini    — from aistudio.google.com/apikey\n' +
      '  openai    — from platform.openai.com\n\n' +
      'Example: /llm anthropic sk-ant-...\n\n' +
      'Your key is stored encrypted and used instead of the host key. DM /llm_remove to disconnect.'
    );
  }

  if (!['anthropic', 'gemini', 'openai'].includes(provider)) {
    return ctx.reply('Unknown provider. Use: anthropic, gemini, or openai');
  }

  setUserLlmKey(ctx.from.id, provider, apiKey);
  ctx.reply(
    `✅ Connected your ${provider} key. Your messages will now use your own ${provider} credits.\n\n` +
    '⚠️ Your key is stored encrypted. DM /llm_remove anytime to disconnect.'
  );
});

tg.command('llm_remove', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  deleteUserLlmKey(ctx.from.id);
  ctx.reply('🗑️ Your LLM key has been removed. The bot will use the host key going forward.');
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

  // Track all group members passively (so "everyone" drops work)
  if (!isPrivate) {
    recordChatMember(chatId, senderId, username);
  }

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

  // BYOLLM enforcement — if host requires users to bring their own key (owner is always exempt)
  if (REQUIRE_USER_LLM && !isOwner && !getUserLlmKey(senderId)) {
    await ctx.reply(
      'This bot requires you to connect your own AI API key.\n\n' +
      'DM me to set it up:\n' +
      '/llm anthropic <key> — from console.anthropic.com\n' +
      '/llm gemini <key> — from aistudio.google.com/apikey\n' +
      '/llm openai <key> — from platform.openai.com'
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
    setChannelProvider(contextId, switchTarget);
    anthropicHistories.delete(contextId);
    geminiHistories.delete(contextId);
    openaiHistories.delete(contextId);
    const modelName = switchTarget === 'gemini' ? GEMINI_MODEL
      : switchTarget === 'openai' ? OPENAI_MODEL
      : switchTarget === 'minds' ? 'Minds'
      : CLAUDE_MODEL;
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
  const userLlmKey = getUserLlmKey(senderId);
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
  };

  let accumulated = '';
  let modelLabel = CLAUDE_MODEL;

  _pendingBasescanUrls.length = 0;

  try {
    // Resolve which LLM key to use: user's own key takes priority over host key
    const effectiveProvider = userLlmKey ? userLlmKey.provider : provider;
    const effectiveLlmKey = userLlmKey?.apiKey ?? null;

    if (effectiveProvider === 'gemini') {
      accumulated = await runGeminiLoop(contextId, contextualText, editor, toolCtx, effectiveLlmKey);
      modelLabel = GEMINI_MODEL;
    } else if (effectiveProvider === 'openai') {
      accumulated = await runOpenAILoop(contextId, contextualText, editor, toolCtx, effectiveLlmKey);
      modelLabel = OPENAI_MODEL;
    } else if (effectiveProvider === 'minds') {
      const creds = getUserMindsCredentials(senderId);
      const mindName = creds?.name ?? 'unknown';
      const stateKey = mindsStateKey(contextId, senderId);
      const lastState = mindsLastResponse.get(stateKey);

      if (lastState?.isPendingAction && isPositiveConfirmation(cleanText)) {
        mindsLastResponse.delete(stateKey);
        const handoffText =
          `${timeContext}\n${senderContext} ${walletNote}\n` +
          `The user's Minds AI agent researched and prepared the following action plan. ` +
          `The user has now confirmed it. Execute it immediately using your tools — no further confirmation needed:\n\n` +
          `---\n${lastState.text}\n---\n\n` +
          `User confirmed: "${cleanText}"`;
        accumulated = await runAnthropicLoop(contextId, handoffText, editor, toolCtx, effectiveLlmKey);
        modelLabel = `${CLAUDE_MODEL} (via Minds)`;
      } else {
        runMindsBackground(contextId, contextualText, chatId, pendingMsg.message_id, senderId, stateKey, mindName)
          .catch((err) => console.error('[minds-bg] unhandled:', err.message));
        return;
      }
    } else {
      accumulated = await runAnthropicLoop(contextId, contextualText, editor, toolCtx, effectiveLlmKey);
      modelLabel = CLAUDE_MODEL;
    }

    let finalText = accumulated || '(no response)';
    for (const url of _pendingBasescanUrls) {
      if (!finalText.includes(url)) finalText += `\n🔗 ${url}`;
    }
    _pendingBasescanUrls.length = 0;

    finalText += `\n— ${modelLabel}`;
    await editor.finalize(finalText);

  } catch (err) {
    console.error(`[${provider}] error:`, err);
    if (provider === 'gemini') { const h = getGeminiHistory(contextId); if (h.at(-1)?.role === 'user') h.pop(); }
    else if (provider === 'openai') { const h = getOpenAIHistory(contextId); if (h.at(-1)?.role === 'user') h.pop(); }
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
  console.log(`   Minds: per-user keys (DM /minds <key> to register)`);
  console.log(`   Quidli: ${QUIDLI_API_KEY ? 'API key' : 'x402 payments'}`);
  console.log(`   Key storage: ${encKey ? 'encrypted (AES-256-GCM)' : '⚠️  plaintext — set MASTER_ENCRYPTION_KEY to encrypt'}`);
  loadPendingDrops();
});

process.once('SIGINT', () => tg.stop('SIGINT'));
process.once('SIGTERM', () => tg.stop('SIGTERM'));
