# TeleCentaur

A Claude-powered Telegram bot with [Quidli Connect](https://connect.quid.li) integration. Send tokens, look up wallets, and check reputation scores — all in plain English, directly in Telegram.

## What it can do

- **Send tokens** — drop USDC or other tokens to anyone by Telegram handle, email, Twitter, Farcaster, and more
- **Look up wallets** — resolve any social identity to an ETH/SOL wallet address
- **Check reputation scores** — get a composite web3 reputation score (Neynar, Lens, Ethos)
- **Schedule drops** — send tokens at a future time, surviving bot restarts
- **Conditional drops** — "if BTC is above $100k, send 1 USDC to @alice" — evaluated automatically using real-time web search
- **Channel watchers** — send tokens to the first person who types a trigger phrase in a group
- **Cancel / reschedule** — manage pending scheduled drops and watchers
- **Per-user API keys** — users can DM `/connect <key>` to link their own Quidli account
- **Multi-LLM support** — switch between Claude, Gemini, OpenAI, OpenRouter, Hermes (Nous Portal, 200+ models), and Minds AI per chat
- **Bring your own key** — users DM `/llm <provider> <key>` to run on their own credits
- **Minds AI handoff** — your personal Mind researches and plans; Claude executes on confirmation

## How it works

```
Telegram message → LLM (Claude / Gemini / OpenAI / Minds AI)
               → Quidli Connect API (lookup / scores / drop)
               → edit Telegram reply in real time
```

**Examples:**
```
send 1 USDC to @ysiu on Twitter
what's the wallet for vitalik.eth on Farcaster?
schedule a drop of 5 USDC to @alice in 2 hours
if ETH hits $5000 today, send 0.5 USDC to @bob
send 0.01 USDC to the first person who types "gm" here today
switch to gemini
switch to claude
switch to minds
```

In groups, @mention the bot or reply to it. In private chat, just message it directly.

## Prerequisites

- Node.js 22+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An Anthropic API key
- A Quidli Connect API key (from [connect.quid.li](https://connect.quid.li))
- *(Optional)* Brave Search API key for web search and conditional drops
- *(Optional)* Gemini or OpenAI API keys for multi-LLM switching

## Setup

### 1. Create a Telegram bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **HTTP API token** — this is your `TELEGRAM_TOKEN`
4. *(Optional)* Send `/setprivacy` → select your bot → **Disable** to allow it to read all group messages (required for watchers)

### 2. Configure environment variables

```bash
cp .env.example .env
# Fill in your values
```

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_TOKEN` | ✅ | Bot token from @BotFather |
| `ANTHROPIC_API_KEY` | ✅ | API key from [console.anthropic.com](https://console.anthropic.com) |
| `QUIDLI_API_KEY` | ✅ | API key from [connect.quid.li](https://connect.quid.li) |
| `MASTER_ENCRYPTION_KEY` | ✅ | 64 hex chars (32 bytes) — encrypts stored user API keys. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `BOT_OWNER_ID` | — | Your Telegram user ID — you can trigger drops using the host Quidli wallet without `/connect`. Find it by messaging [@userinfobot](https://t.me/userinfobot). |
| `BRAVE_SEARCH_API_KEY` | — | From [brave.com/search/api](https://brave.com/search/api) — required for web search and conditional drops |
| `CLAUDE_MODEL` | — | Defaults to `claude-sonnet-4-6` |
| `DEFAULT_LLM_PROVIDER` | — | `anthropic` (default), `gemini`, `openai`, or `hermes` |
| `GEMINI_API_KEY` | — | From [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | — | Defaults to `gemini-2.5-flash` |
| `OPENAI_API_KEY` | — | From [platform.openai.com](https://platform.openai.com) |
| `OPENAI_MODEL` | — | Defaults to `gpt-4o` |
| `NOUS_API_KEY` | — | From [portal.nousresearch.com](https://portal.nousresearch.com) — one key, 200+ models |
| `NOUS_MODEL` | — | Defaults to `tencent/hy3:free` (free tier, supports tool calling) |
| `TELEGRAM_ALLOWED_USERS` | — | Comma-separated Telegram user IDs allowed to use the bot. Empty = everyone |
| `BOT_WALLET_PRIVATE_KEY` | — | Private key of a funded wallet for x402 pay-per-request on `/lookup` |
| `SYSTEM_PROMPT` | — | Override the default system prompt |

### 3. Enable Smart Send (for token drops)

1. Log in at [connect.quid.li](https://connect.quid.li)
2. Go to **Smart Send** and toggle it on
3. Fund the Smart Send wallet with tokens and ETH for gas

### 4. Install and run

```bash
npm install
npm start
```

For production with pm2:
```bash
pm2 start bot.js --name telecentaur
pm2 save
```

## Per-user API keys

Users can link their own Quidli account so drops use their Smart Send wallet. Send these commands in a **private chat** with the bot:

```
/connect <your-api-key>   — link your Quidli account
/revoke                   — remove your stored API key
```

Keys are stored encrypted with AES-256-GCM.

## Multi-LLM switching

Switch the active LLM per chat at any time:

```
switch to gemini
switch to claude
switch to openai
switch to hermes
switch to openrouter
```

Naming a model in the phrase selects it too — `switch to fable`, `switch to opus`,
`switch to kimi`, `switch to llama`, `switch to deepseek`, `switch to mistral`.

The choice persists across bot restarts (stored in SQLite).

### Bring your own key

Any user can run on their own credits by DMing the bot. Keys are stored AES-256-GCM
encrypted (set `MASTER_ENCRYPTION_KEY`) and used instead of the host's:

```
/llm anthropic <key>
/llm gemini <key>
/llm openai <key>
/llm openrouter <key> [model]
/llm hermes <key> [model]
/llm_remove
```

### OpenRouter

`switch to openrouter` routes through [openrouter.ai](https://openrouter.ai) — 100+ models on one
key. There's no host-level OpenRouter key: it's per-user only, so each person DMs `/llm openrouter
<key>` first. Default model is `openai/gpt-4o`.

### Hermes / Nous Portal

`switch to hermes` routes the chat through [Nous Portal](https://portal.nousresearch.com), an
OpenAI-compatible gateway to 200+ models under one key. Set `NOUS_API_KEY` to give everyone the
host default (`NOUS_MODEL`, defaults to `tencent/hy3:free` — free tier and supports tool calling).

Users can bring their own key and choose any model by DMing the bot:

```
/llm hermes <your-nous-key> anthropic/claude-sonnet-4.6
/llm hermes <your-nous-key> tencent/hy3:free
```

Model slugs are vendor-prefixed; free variants end in `:free`. Note that Nous's own docs advise
against the `Hermes-4-*` models for rapid tool-calling loops — prefer an agentic model for drops
and lookups.

### Minds AI (experimental)

Minds AI is a platform by Animoca Brands that lets you deploy custom AI agents trained on your own data. TeleCentaur can route messages to your personal Mind.

**How to connect your Mind** (in a private chat with the bot):

```
/minds <builder-api-key>
/minds <builder-api-key> <mind-name>   — if you have more than one Mind
```

Get a Builder API key at [build.hellominds.ai/console](https://build.hellominds.ai/console).

Then in any chat: `switch to minds`

**How the handoff works:** Your Mind researches the request and presents a plan. When you confirm (say "yes", "do it", etc.), Claude takes over and executes the actual token transfer using Quidli.

```
/minds_remove   — disconnect your Minds credentials
```

> **⚠️ Experimental.** The Minds API can be intermittently unreliable. For anything critical, switch to Claude.

## Scheduled & conditional drops

```
send 1 USDC to @alice in 3 hours
if ETH hits $5000 today, send 0.5 USDC to @bob
list my scheduled drops
cancel drop <id>
```

Scheduled drops survive bot restarts. Conditional drops use Brave Search to evaluate the condition at the scheduled check time.

## Channel watchers

```
send 0.01 USDC to the first person who types "gm" here
give 1 USDC to the first 3 people who say "wagmi" in this chat
list my watchers
cancel watcher <id>
```

## Troubleshooting

**Bot doesn't respond in groups:** Make sure group privacy mode is disabled. In @BotFather, send `/setprivacy` → select your bot → **Disable**. Then remove and re-add the bot to the group.

**Drop returns 400:** Ensure Smart Send is enabled and funded at [connect.quid.li](https://connect.quid.li).

**Score returns 404:** Confirm `QUIDLI_API_KEY` is set in `.env`.

**Conditional drop fires at wrong time:** Make sure `BRAVE_SEARCH_API_KEY` is set.

**Gemini not calling tools:** Known limitation. Switch back to Claude for drops, lookups, or scheduling.
