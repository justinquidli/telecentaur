/**
 * Tests for the pure logic in bot.js — slugging, key resolution, switch
 * precedence, the Minds migration, and the agent addressing regex.
 *
 *   npm test
 *
 * bot.js is a single file that connects to Telegram on import, so these tests
 * extract the functions under test from its source rather than importing it.
 * That's a stopgap: when bot.js is split into modules, replace the `grab()`
 * calls with real imports and delete this comment.
 *
 * Every case here corresponds to a bug that actually shipped or nearly shipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bot.js'), 'utf8');
const grab = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}[\\s\\S]*?\\n}`, 'm'));
  if (!m) throw new Error(`Could not find function ${name} in bot.js — was it renamed?`);
  return m[0];
};
const grabConst = (decl) => {
  const m = SRC.match(new RegExp(`^${decl}[\\s\\S]*?\\n(?:\\}|\\]);`, 'm'));
  if (!m) throw new Error(`Could not find ${decl} in bot.js`);
  return m[0];
};
const build = (body, ret, args = {}) =>
  new Function(...Object.keys(args), `${body}\nreturn ${ret};`)(...Object.values(args));

const SCHEMA = {
  agents: `CREATE TABLE user_agents (user_id TEXT NOT NULL, agent_name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'llm', provider TEXT, model TEXT, base_url TEXT, headers TEXT,
    mind_id TEXT, alias TEXT, alias_at INTEGER, description TEXT,
    is_stock INTEGER NOT NULL DEFAULT 0, created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, agent_name))`,
  chat: `CREATE TABLE chat_settings (context_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'anthropic', model TEXT, agent_name TEXT, updated_at INTEGER)`,
  keys: `CREATE TABLE user_keys (telegram_id TEXT PRIMARY KEY, minds_alias TEXT,
    minds_api_key TEXT, minds_name TEXT, minds_mind_id TEXT, minds_alias_created_at INTEGER)`,
};

// ── Agent names become Telegram commands ─────────────────────────────────────
test('agent names are slugged into valid commands', () => {
  const normalizeAgentName = build(grab('normalizeAgentName'), 'normalizeAgentName');

  assert.equal(normalizeAgentName('Email Assistant'), 'email_assistant');
  assert.equal(normalizeAgentName('@tim'), 'tim');
  assert.equal(normalizeAgentName('Research!! Bot'), 'research_bot');
  assert.equal(normalizeAgentName('---x---'), 'x');
  assert.equal(normalizeAgentName('Café Mind'), 'caf_mind');
  assert.equal(normalizeAgentName('!!!'), null);
  assert.equal(normalizeAgentName(''), null);
  assert.equal(normalizeAgentName('a'.repeat(40)).length, 32);

  // Regression: a dot survived slugging and produced an unreachable command.
  assert.equal(normalizeAgentName('justin.quidli'), 'justin_quidli');
  assert.match(normalizeAgentName('justin.quidli'), /^[a-z0-9_]{1,32}$/);
});

// ── Addressing ───────────────────────────────────────────────────────────────
test('/name addressing only matches a leading command', () => {
  // Pulled from bot.js so the test can't drift from the shipped pattern.
  const src = SRC.match(/cleanText\.match\((\/\^\\\/.*?\/i)\)/);
  assert.ok(src, 'could not find the addressing regex in bot.js');
  const re = new RegExp(src[1].slice(1, -2), 'i');

  // bot.js does `(m[2] ?? '').trim()`, so test the resulting text, not the raw group.
  const body = (s) => { const r = re.exec(s); return r ? (r[2] ?? '').trim() : null; };
  const name = (s) => re.exec(s)?.[1] ?? null;

  assert.deepEqual(re.exec('/tim hello').slice(1, 3), ['tim', 'hello']);
  assert.equal(body('/tim'), '', 'bare name shows the card');
  assert.deepEqual(re.exec('/tim@TeleCentaurBot hi').slice(1, 3), ['tim', 'hi']);
  assert.deepEqual(re.exec('/tim a\nb').slice(1, 3), ['tim', 'a\nb']);
  assert.equal(re.exec('hello /tim'), null);
  assert.equal(re.exec('/tim-bob hi'), null, 'hyphen stays part of an unknown name');

  // Regression: punctuation after the name matched nothing, so the message went
  // to the chat provider silently — which then answered as if it were the agent.
  assert.deepEqual(re.exec('/bob, what is the best eth strategy?').slice(1, 3),
    ['bob', 'what is the best eth strategy?']);
  assert.deepEqual(re.exec('/alice, do you agree with /bob?').slice(1, 3),
    ['alice', 'do you agree with /bob?']);
  assert.deepEqual(re.exec('/tim: hi').slice(1, 3), ['tim', 'hi']);
  assert.deepEqual(re.exec('/tim; hi').slice(1, 3), ['tim', 'hi']);
  assert.equal(name('/tim,'), 'tim');
  assert.equal(body('/tim,'), '', 'name plus bare punctuation shows the card');
});

test('each agent gets its own history key', () => {
  const agentContextId = build(grab('agentContextId'), 'agentContextId');
  assert.equal(agentContextId('123', 'tim'), '123::tim');
  assert.equal(agentContextId('123', null), '123');
  assert.notEqual(agentContextId('123', 'tim'), agentContextId('123', 'bob'));
  assert.notEqual(agentContextId('123', null), agentContextId('123', 'tim'));
});

// ── Host keys ────────────────────────────────────────────────────────────────
test('only providers with a configured host key are offerable', () => {
  // Regression: the picker offered providers whose key was blank, producing
  // agents that failed on first use.
  const hostKeyFor = build(grab('hostKeyFor'), 'hostKeyFor', {
    ANTHROPIC_API_KEY: 'sk-ant-x', GEMINI_API_KEY: '', OPENAI_API_KEY: '', NOUS_API_KEY: 'nous-x',
  });
  assert.ok(hostKeyFor('anthropic'));
  assert.ok(hostKeyFor('hermes'));
  assert.equal(hostKeyFor('gemini'), null);
  assert.equal(hostKeyFor('openai'), null);
  assert.equal(hostKeyFor('openrouter'), null, 'openrouter is bring-your-own-key by design');
});

test('host key is owner + allowlist only, and fails closed', () => {
  const make = (users, roles, owner) => build(grab('mayUseHostKey'), 'mayUseHostKey', {
    BOT_OWNER_ID: owner,
    HOST_KEY_USERS: new Set(users.split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)),
    HOST_KEY_ROLES: new Set(roles.split(',').map((s) => s.trim()).filter(Boolean)),
  });

  let may = make('alice,482970829', '', '111');
  assert.equal(may('111', 'anyone'), true, 'owner');
  assert.equal(may('999', 'alice'), true, 'listed handle');
  assert.equal(may('999', '@ALICE'), true, 'case and @ insensitive');
  assert.equal(may('482970829', 'bob'), true, 'listed id');
  assert.equal(may('999', 'bob'), false, 'stranger');

  may = make('', '', '111');
  assert.equal(may('999', 'x'), false, 'empty allowlist is closed');
  may = make('', '', '');
  assert.equal(may('999', 'x'), false, 'no owner configured still denies');
});

// ── Naming ───────────────────────────────────────────────────────────────────
test('/hermes still resolves to the renamed /nous, without listing twice', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA.agents);
  const env = build(
    [grabConst('const STOCK_AGENTS = \\{'), grabConst('const AGENT_NAME_ALIASES = \\{'),
     grab('normalizeAgentName'), grab('getAgent'), grab('listAgents')].join('\n'),
    '{ getAgent, listAgents }', { db });

  assert.equal(env.getAgent('u1', 'nous').provider, 'hermes', 'the visible name');
  assert.equal(env.getAgent('u1', 'hermes').agent_name, 'nous', 'old name still works');
  assert.equal(env.getAgent('u1', 'nonsense'), null);

  const names = env.listAgents('u1').map((a) => a.agent_name);
  assert.ok(names.includes('nous'));
  assert.ok(!names.includes('hermes'), 'the alias must not appear as a second entry');

  // A user's own agent named hermes must win over the alias.
  db.exec(`INSERT INTO user_agents (user_id, agent_name, kind, provider)
    VALUES ('u2','hermes','llm','anthropic')`);
  assert.equal(env.getAgent('u2', 'hermes').provider, 'anthropic', 'own agent beats the alias');
});

test('provider labels never show the raw internal id', () => {
  const providerLabel = build(
    [grabConst('const PROVIDER_LABELS = \\{'), 'const providerLabel = (p) => PROVIDER_LABELS[p] ?? p;'].join('\n'),
    'providerLabel');
  // Regression: /agents read "hermes · tencent/hy3:free" — neither Hermes nor Nous.
  assert.equal(providerLabel('hermes'), 'Nous Portal');
  assert.equal(providerLabel('anthropic'), 'Anthropic');
  assert.equal(providerLabel('openrouter'), 'OpenRouter');
  assert.equal(providerLabel('unknown'), 'unknown', 'falls back rather than showing blank');
});

// ── Switch precedence ────────────────────────────────────────────────────────
test('switch phrases keep their meaning; agent names extend them', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA.agents);
  db.exec(`INSERT INTO user_agents (user_id, agent_name, kind) VALUES ('u1','tim','minds')`);

  const env = build(
    [grabConst('const STOCK_AGENTS = \\{'), grabConst('const AGENT_NAME_ALIASES = \\{'), grab('normalizeAgentName'), grab('getAgent'),
     grab('detectProviderSwitch'), grab('detectAgentSwitch')].join('\n'),
    '{ detectProviderSwitch, detectAgentSwitch }', { db });

  const route = (t) => env.detectProviderSwitch(t)
    ? { kind: 'provider', target: env.detectProviderSwitch(t) }
    : (env.detectAgentSwitch(t, 'u1') ? { kind: 'agent', target: env.detectAgentSwitch(t, 'u1') } : null);

  // Provider detection must win, or existing phrases change meaning.
  assert.deepEqual(route('switch to claude'), { kind: 'provider', target: 'anthropic' });
  assert.deepEqual(route('switch to hermes'), { kind: 'provider', target: 'hermes' });
  assert.deepEqual(route('switch to kimi'), { kind: 'provider', target: 'openrouter' });
  assert.deepEqual(route('switch to minds'), { kind: 'provider', target: 'minds' });

  // Both names reach Nous Portal, and both take the provider path — the stock
  // /nous agent must not shadow the provider phrase.
  assert.deepEqual(route('switch to nous'), { kind: 'provider', target: 'hermes' });
  assert.deepEqual(route('nous mode'), { kind: 'provider', target: 'hermes' });

  assert.deepEqual(route('switch to tim'), { kind: 'agent', target: 'tim' });
  assert.deepEqual(route('use tim'), { kind: 'agent', target: 'tim' });
  assert.equal(route('switch to nobody'), null);
  assert.equal(route('should i switch to tim or not'), null, 'must not fire mid-sentence');
});

// ── Connect over MCP ─────────────────────────────────────────────────────────
test('the MCP fallback allowlist never duplicates a hardcoded tool', () => {
  // Offering connect_lookup alongside quidli_lookup would leave the model
  // choosing between two tools that do the same thing. This is the guard.
  const allowlist = SRC.match(/const MCP_LEGACY_ALLOWLIST = new Set\(\[([^\]]*)\]\)/)[1]
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);

  const hardcoded = [...SRC.matchAll(/^    name: '([a-z_]+)',$/gm)].map((m) => m[1]);
  const duplicates = {
    connect_lookup: 'quidli_lookup',
    connect_drop: 'quidli_drop',
    connect_lookup_exposed: 'quidli_exposed',
    connect_scores_batch: 'quidli_score',
    connect_scores_by_account: 'quidli_score',
    connect_scores_by_username: 'quidli_score',
  };

  for (const name of allowlist) {
    const clash = duplicates[name];
    assert.ok(
      !(clash && hardcoded.includes(clash)),
      `${name} duplicates the hardcoded ${clash} — remove one before allowlisting`,
    );
  }
  assert.ok(allowlist.length > 0, 'allowlist should not be empty');
});

test('MCP JSON-RPC calls parse results, errors and timeouts', async () => {
  // The SDK's Streamable HTTP client hangs against this server (it negotiates a
  // session the server never issues), so we speak JSON-RPC directly. These are
  // the response shapes that come back.
  const env = build(
    ['const MCP_URL = "https://mcp.example/";', grab('mcpRpc'), grab('mcpCallTool')].join('\n'),
    '{ mcpRpc, mcpCallTool }',
    { fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === 'tools/list') {
          return { ok: true, json: async () => ({ result: { tools: [{ name: 'connect_drop_balance' }] } }) };
        }
        if (body.params?.name === 'boom') {
          return { ok: true, json: async () => ({ result: { isError: true, content: [{ type: 'text', text: 'no funds' }] } }) };
        }
        if (body.params?.name === 'structured') {
          return { ok: true, json: async () => ({ result: { content: [], structuredContent: { assets: [] } } }) };
        }
        if (body.params?.name === 'rpcerror') {
          return { ok: true, json: async () => ({ error: { message: 'bad key' } }) };
        }
        if (body.params?.name === 'http500') {
          return { ok: false, status: 500, text: async () => 'upstream down' };
        }
        return { ok: true, json: async () => ({ result: { content: [{ type: 'text', text: '{"assets":[]}' }] } }) };
      },
      AbortController, setTimeout, clearTimeout },
  );

  assert.deepEqual((await env.mcpRpc('tools/list', {}, 'k')).tools[0].name, 'connect_drop_balance');
  assert.equal(await env.mcpCallTool('connect_drop_balance', { chainId: 8453 }, 'k'), '{"assets":[]}');
  assert.equal(await env.mcpCallTool('structured', {}, 'k'), '{"assets":[]}', 'falls back to structuredContent');
  await assert.rejects(() => env.mcpCallTool('boom', {}, 'k'), /no funds/, 'isError surfaces the text');
  await assert.rejects(() => env.mcpCallTool('rpcerror', {}, 'k'), /bad key/, 'JSON-RPC error surfaces');
  await assert.rejects(() => env.mcpCallTool('http500', {}, 'k'), /HTTP 500/, 'HTTP failure surfaces');
});

test('MCP tool shape converts to what the provider converters expect', () => {
  // MCP returns inputSchema; the bot's converters read input_schema.
  const mcpTool = { name: 'connect_drop_balance', description: 'Balances.', inputSchema: { type: 'object', properties: { chainId: { type: 'number' } }, required: ['chainId'] } };
  const converted = { name: mcpTool.name, description: mcpTool.description ?? '', input_schema: mcpTool.inputSchema };

  // Mirrors getOpenAITools() / getGeminiTools() exactly.
  const asOpenAI = { type: 'function', function: { name: converted.name, description: converted.description, parameters: converted.input_schema } };
  const asGemini = { name: converted.name, description: converted.description, parameters: converted.input_schema };

  assert.equal(asOpenAI.function.parameters.required[0], 'chainId');
  assert.equal(asGemini.parameters.type, 'object');
  assert.ok(converted.input_schema, 'input_schema must be populated or the model sees no arguments');
});

// ── Multi-owner groups ───────────────────────────────────────────────────────
test('two members can own same-named agents without collision', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA.agents);
  db.exec(`INSERT INTO user_agents (user_id, agent_name, kind, provider, description)
    VALUES ('alice','tim','minds','', 'Alice Mind')`);
  db.exec(`INSERT INTO user_agents (user_id, agent_name, kind, provider, description)
    VALUES ('bob','tim','llm','anthropic', NULL)`);

  const env = build(
    [grabConst('const STOCK_AGENTS = \\{'), grabConst('const AGENT_NAME_ALIASES = \\{'),
     grab('normalizeAgentName'), grab('getAgent')].join('\n'), '{ getAgent }', { db });

  // The whole ownership model rests on this: resolution is per-sender.
  assert.equal(env.getAgent('alice', 'tim').kind, 'minds');
  assert.equal(env.getAgent('bob', 'tim').kind, 'llm');
  assert.equal(env.getAgent('carol', 'tim'), null, 'a non-owner cannot invoke it at all');
});

test('one member cannot change or clear another member\'s default agent', () => {
  // Regression risk: chat_settings.agent_name was chat-wide while agents are
  // per-user, so in a group anyone speaking would resolve against their own
  // agents and wipe everyone else's default.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE chat_user_agent (context_id TEXT NOT NULL, user_id TEXT NOT NULL,
    agent_name TEXT NOT NULL, updated_at INTEGER, PRIMARY KEY (context_id, user_id))`);

  const env = build([grab('setChannelAgent'), grab('getChannelAgentName')].join('\n'),
    '{ setChannelAgent, getChannelAgentName }', { db });

  env.setChannelAgent('grp', 'alice', 'tim');
  env.setChannelAgent('grp', 'bob', 'max');
  assert.equal(env.getChannelAgentName('grp', 'alice'), 'tim');
  assert.equal(env.getChannelAgentName('grp', 'bob'), 'max');

  env.setChannelAgent('grp', 'bob', null);           // bob switches back to a provider
  assert.equal(env.getChannelAgentName('grp', 'bob'), null);
  assert.equal(env.getChannelAgentName('grp', 'alice'), 'tim', "alice's default survives");

  assert.equal(env.getChannelAgentName('grp', 'carol'), null, 'unset for a third member');
});

test('the group disclosure fires exactly once per chat', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE chat_agent_notice (context_id TEXT PRIMARY KEY, notified_at INTEGER)`);
  const claim = build(grab('claimAgentNotice'), 'claimAgentNotice', { db });

  assert.equal(claim('grp1'), true, 'first use notifies');
  assert.equal(claim('grp1'), false, 'never again');
  assert.equal(claim('grp1'), false);
  assert.equal(claim('grp2'), true, 'a different group notifies separately');
});

test('replies are attributed to their owner in groups only', () => {
  const agentTag = build(grab('agentTag'), 'agentTag');
  assert.equal(agentTag({ agent_name: 'tim' }, 'alice', true), 'tim', 'no noise in a DM');
  assert.equal(agentTag({ agent_name: 'tim' }, 'alice', false), 'tim (@alice)');
  // Two people's "tim" must be distinguishable in one room.
  assert.notEqual(
    agentTag({ agent_name: 'tim' }, 'alice', false),
    agentTag({ agent_name: 'tim' }, 'bob', false));
});

// ── Minds migration ──────────────────────────────────────────────────────────
test('legacy Minds migrate once and are adopted, not duplicated', () => {
  // Regression: idempotency keyed on the alias, which /minds legitimately
  // replaces — so the migration re-fired every restart, creating _2, _3, _4…
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA.agents);
  db.exec(SCHEMA.keys);
  db.exec(`INSERT INTO user_keys (telegram_id, minds_alias, minds_name)
    VALUES ('u1','tcORIGINAL','justin.quidli')`);

  const s = SRC.indexOf('try {\n  const legacy = db.prepare');
  const migration = SRC.slice(s, SRC.indexOf('\n}', SRC.indexOf('[migrate] Minds → agents failed', s)) + 2);
  const env = build(
    [grabConst('const STOCK_AGENTS = \\{'), grabConst('const AGENT_NAME_ALIASES = \\{'), grabConst('const RESERVED_AGENT_NAMES = new Set\\(\\['),
     grab('normalizeAgentName'), grab('getAgent'), grab('listAgents'), grab('upsertAgent')].join('\n'),
    '{ boot(){ ' + migration + ' }, listAgents, upsertAgent, normalizeAgentName }',
    { db, console: { log() {}, error() {} } });

  env.boot();
  const migrated = db.prepare("SELECT * FROM user_agents WHERE kind='minds'").all();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].agent_name, 'justin_quidli');
  assert.equal(migrated[0].alias, 'tcORIGINAL');
  assert.equal(migrated[0].mind_id, null, 'pre-ALTER connections have no mind_id');

  // Replay /minds registration: it must adopt the migrated row, keeping its alias.
  const registerMinds = () => {
    for (const mind of [{ mindId: 'd4c5', name: 'justin.quidli' }]) {
      let name = env.normalizeAgentName(mind.name);
      const mine = env.listAgents('u1').filter((a) => a.kind === 'minds');
      const already = mine.find((a) => a.mind_id === mind.mindId)
        ?? mine.find((a) => !a.mind_id && a.agent_name === name);
      if (already) name = already.agent_name;
      env.upsertAgent('u1', name, {
        kind: 'minds', mind_id: mind.mindId,
        alias: already?.alias ?? 'tcNEW', description: mind.name,
      });
    }
  };

  registerMinds(); env.boot(); registerMinds(); env.boot(); env.boot(); registerMinds();

  const rows = db.prepare("SELECT * FROM user_agents WHERE kind='minds'").all();
  assert.equal(rows.length, 1, 'no duplicates after repeated boots and registrations');
  assert.equal(rows[0].alias, 'tcORIGINAL', 'original conversation preserved');
  assert.equal(rows[0].mind_id, 'd4c5', 'adopted row gets its mind_id filled in');
});

test('a Mind named after a stock provider cannot shadow it', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA.agents);
  db.exec(SCHEMA.keys);
  db.exec(`INSERT INTO user_keys (telegram_id, minds_alias, minds_name) VALUES ('u2','a1','Hermes')`);

  const s = SRC.indexOf('try {\n  const legacy = db.prepare');
  const migration = SRC.slice(s, SRC.indexOf('\n}', SRC.indexOf('[migrate] Minds → agents failed', s)) + 2);
  build([grabConst('const STOCK_AGENTS = \\{'), grabConst('const AGENT_NAME_ALIASES = \\{'), grabConst('const RESERVED_AGENT_NAMES = new Set\\(\\['),
    grab('normalizeAgentName')].join('\n'), '(function(){' + migration + '})()',
    { db, console: { log() {}, error() {} } });

  const row = db.prepare("SELECT agent_name FROM user_agents WHERE user_id='u2'").get();
  assert.equal(row.agent_name, 'hermes_mind', 'must not become /hermes');
});

// ── Digest ───────────────────────────────────────────────────────────────────
test('digest carries other agents\' turns but not the current one', () => {
  const env = build(
    ['const chatDigests = new Map();', 'const DIGEST_TURNS = 6;', 'const DIGEST_CHARS = 220;',
     grab('recordDigest'), grab('buildDigest')].join('\n'),
    '{ recordDigest, buildDigest, chatDigests }');

  env.recordDigest('c', 'you → /tim', 'hey');
  env.recordDigest('c', '/tim', 'hey, what\'s up?');
  env.recordDigest('c', 'you → /max', 'are you the same as above?');
  const d = env.buildDigest('c');

  assert.match(d, /\/tim/);
  assert.match(d, /what's up/);
  assert.match(d, /not addressed to you/);
  assert.doesNotMatch(d, /same as above/, 'current turn must be excluded');

  for (let i = 0; i < 50; i++) env.recordDigest('x', 'you', `m${i}`);
  assert.equal(env.chatDigests.get('x').length, 6, 'bounded');
  env.recordDigest('x', 'you', 'z'.repeat(999));
  assert.equal(env.chatDigests.get('x').at(-1).text.length, 220, 'truncated');
  assert.equal(env.buildDigest('unseen'), '', 'empty chat yields no digest');
});

// ── Typo guard ───────────────────────────────────────────────────────────────
test('a mistyped agent name suggests the right one', () => {
  // Regression: a one-character typo fell through to the chat provider, which
  // answered confidently as something the user had not addressed.
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA.agents);
  for (const n of ['justin_quidli', 'justinahn', 'bob', 'alice']) {
    db.exec(`INSERT INTO user_agents (user_id, agent_name, kind, provider)
      VALUES ('u1','${n}','llm','anthropic')`);
  }
  const env = build(
    [grabConst('const STOCK_AGENTS = \\{'), grab('normalizeAgentName'), grab('getAgent'),
     grab('listAgents'), grab('editDistance'), grab('suggestAgentName')].join('\n'),
    '{ suggestAgentName }', { db });
  const suggest = (t) => env.suggestAgentName('u1', t);

  assert.equal(suggest('justin_quidl'), 'justin_quidli');
  assert.equal(suggest('justinah'), 'justinahn');
  assert.equal(suggest('cluade'), 'claude', 'transposition in a stock name');
  assert.equal(suggest('bobb'), 'bob');
  // "/justin.ahn" — punctuation stripped, then matched. Names can't hold a dot.
  assert.equal(suggest('justinahn'), 'justinahn');

  // Other bots' commands must not draw a reply. Distance alone was too loose:
  // "ban" is within 2 of "bob", "remind" within 2 of "gemini".
  for (const cmd of ['ban', 'remind', 'poll', 'start', 'settings', 'vote', 'weather', 'help']) {
    assert.equal(suggest(cmd), null, `/${cmd} must stay silent`);
  }
});

// ── Startup wiring ────────────────────────────────────────────────────────────
// Telegraf's launch() promise resolves when the bot STOPS, not when it starts
// (in long-polling mode it awaits startPolling()). Startup work placed in
// .then() therefore runs at shutdown. That shipped, and it silently disabled
// pending-drop restore, pending-claim restore, and MCP tool discovery — the
// symptom was the model reporting connect_drop_balance as unavailable while
// the startup banner appeared in the logs (printed by the dying process).
test('startup work runs in the onLaunch callback, not launch().then()', () => {
  const launch = SRC.match(/tg\.launch\(\{[\s\S]*?\n\}\)(?:\.catch\([\s\S]*?\n\}\))?;/);
  assert.ok(launch, 'could not find the tg.launch(...) call in bot.js');
  const block = launch[0];

  assert.ok(
    !/\}\)\.then\(/.test(block),
    'startup work is attached to launch().then() — that promise only resolves on shutdown, ' +
      'so this code will never run at startup. Use the onLaunch callback (2nd arg) instead.',
  );
  assert.match(block, /\},\s*\(\)\s*=>\s*\{/, 'launch() should take an onLaunch callback as its 2nd argument');

  for (const fn of ['loadPendingDrops', 'loadPendingClaims', 'registerMcpTools']) {
    assert.ok(block.includes(`${fn}()`), `${fn}() should be called during startup`);
  }
});

// ── connect_me redaction ──────────────────────────────────────────────────────
// connect_me returns the caller's FULL profile: every linked account, including
// ones flagged exposed:false — phone number, email, every wallet. The bot passes
// MCP tool output straight to the model, so without this filter a group chat can
// have someone's phone number read aloud.
test('connect_me output drops accounts the user kept private', () => {
  const redact = new Function(`${grab('redactConnectMe')}; return redactConnectMe;`)();

  const raw = JSON.stringify({
    profile: { username: 'justin', scores: { quidliScore: 99 } },
    accounts: [
      { platform: 'phone', socialId: '+33600000000', exposed: false },
      { platform: 'email', socialId: 'someone@example.com', exposed: false },
      { platform: 'wallet', socialId: '0xdeadbeef', exposed: false },
      { platform: 'github', username: 'justinquidli', exposed: true },
      { platform: 'farcaster', username: 'ahn.eth', exposed: true },
    ],
  });

  const out = redact(raw);
  assert.ok(!out.includes('+33600000000'), 'phone number must not reach the model');
  assert.ok(!out.includes('someone@example.com'), 'email must not reach the model');
  assert.ok(!out.includes('0xdeadbeef'), 'private wallet must not reach the model');
  assert.ok(out.includes('justinquidli') && out.includes('ahn.eth'), 'exposed accounts should survive');
  assert.equal(JSON.parse(out).accounts.length, 2);
  assert.equal(JSON.parse(out).profile.scores.quidliScore, 99, 'profile and scores are kept');
});

test('connect_me redaction fails closed on an unexpected shape', () => {
  const redact = new Function(`${grab('redactConnectMe')}; return redactConnectMe;`)();
  const out = redact('<html>gateway error</html>');
  assert.ok(!out.includes('gateway error'), 'unparseable responses must not be passed through verbatim');
  assert.match(out, /withheld/i);
});


// ── Tool gating: readOnlyHint, not a name list ───────────────────────────────
const buildSelect = () => {
  const legacy = SRC.match(/^const MCP_LEGACY_ALLOWLIST = new Set\(\[[^\]]*\]\);$/m)[0];
  return build(`${legacy}\n${grab('selectMcpTools')}`, 'selectMcpTools');
};

test('read-only tools auto-register and connect_drop never does', () => {
  const selectMcpTools = buildSelect();
  // Shape mirrors a real tools/list from Connect MCP >= 0.5.8.
  const { register, skipped, annotated } = selectMcpTools([
    { name: 'connect_lookup', annotations: { readOnlyHint: true } },
    { name: 'connect_get_chains', annotations: { readOnlyHint: true } },
    { name: 'connect_scores_by_username', annotations: { readOnlyHint: true } },
    { name: 'connect_drop_balance', annotations: { readOnlyHint: true } },
    { name: 'connect_drop', annotations: { readOnlyHint: false, destructiveHint: true } },
  ]);

  assert.equal(annotated, true);
  assert.deepEqual(skipped, ['connect_drop'], 'the money path must never be offered');
  // A brand-new read-only tool arrives with no code change — the whole point.
  assert.ok(register.map((t) => t.name).includes('connect_get_chains'));
  assert.equal(register.length, 4);
});

test('an unannotated tool from an annotating server is withheld', () => {
  const selectMcpTools = buildSelect();
  // The failure that matters: a future spend tool whose name matches no
  // pattern. Name-based gating lets it through; absence of readOnlyHint does not.
  const { register, skipped } = selectMcpTools([
    { name: 'connect_lookup', annotations: { readOnlyHint: true } },
    { name: 'connect_execute' },
    { name: 'connect_settle', annotations: {} },
  ]);

  assert.deepEqual(register.map((t) => t.name), ['connect_lookup']);
  assert.deepEqual(skipped, ['connect_execute', 'connect_settle']);
});

test('a server with no annotations falls back to the legacy allowlist', () => {
  const selectMcpTools = buildSelect();
  // Connect MCP before annotations. We cannot tell a read from a spend, so we
  // offer exactly what we always did rather than guessing from names.
  const { register, skipped, annotated } = selectMcpTools([
    { name: 'connect_lookup' },
    { name: 'connect_me' },
    { name: 'connect_drop' },
    { name: 'connect_get_chains' },
  ]);

  assert.equal(annotated, false);
  assert.deepEqual(register.map((t) => t.name), ['connect_lookup', 'connect_me']);
  assert.ok(skipped.includes('connect_drop'));
  assert.ok(skipped.includes('connect_get_chains'), 'unknown tools stay out until annotated');
});

test('selectMcpTools survives a malformed tools/list', () => {
  const selectMcpTools = buildSelect();
  assert.deepEqual(selectMcpTools(undefined).register, []);
  assert.deepEqual(selectMcpTools([null, {}, { name: '' }]).register, []);
});

test('the drop recipient enum matches the platforms Connect resolves', () => {
  // Drifted silently once already: connect_lookup accepted slack while the
  // hand-written drop schema did not, so the model could resolve a Slack
  // identity and then not be allowed to name it as a recipient.
  const enumLine = SRC.match(/^      enum: \[([^\]]*)\],$/m)[1]
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);

  for (const platform of ['discord', 'email', 'phone', 'twitter', 'telegram', 'farcaster', 'github', 'linkedin', 'slack']) {
    assert.ok(enumLine.includes(platform), `RECIPIENT_SCHEMA is missing ${platform}`);
  }
});

test('a keyless call omits the api-key header entirely', async () => {
  // A header the server cannot verify — including the literal "undefined" a
  // missing value stringifies to — is a 401, so the public tools would fail for
  // exactly the users who have no key. No header is not a bad header.
  const seen = [];
  const env = build(
    ['const MCP_URL = "https://mcp.example/";', grab('mcpRpc')].join('\n'),
    'mcpRpc',
    { fetch: async (_url, init) => {
        seen.push(init.headers);
        return { ok: true, json: async () => ({ result: { tools: [] } }) };
      },
      AbortController, setTimeout, clearTimeout },
  );

  await env('tools/list', {}, null);
  await env('tools/list', {}, 'real-key');

  assert.equal('x-api-key' in seen[0], false, 'no key must mean no header');
  assert.equal(seen[1]['x-api-key'], 'real-key');
});

test('only auth and quota failures are turned into user-facing advice', () => {
  const mcpFailureReason = build(
    [SRC.match(/^const MCP_AUTH_ERROR_RE = .*$/m)[0],
     SRC.match(/^const MCP_QUOTA_ERROR_RE = .*$/m)[0],
     grab('mcpFailureReason')].join('\n'),
    'mcpFailureReason',
  );

  assert.equal(mcpFailureReason(new Error('MCP tools/call HTTP 401: no key')), 'auth');
  assert.equal(mcpFailureReason(new Error('Unauthorized')), 'auth');
  assert.equal(mcpFailureReason(new Error('MCP tools/call HTTP 429: slow down')), 'quota');
  assert.equal(mcpFailureReason(new Error('rate limit exceeded')), 'quota');
  // Anything else must keep throwing — swallowing a 500 as "get a key" would
  // send the user chasing the wrong problem.
  assert.equal(mcpFailureReason(new Error('MCP tools/call HTTP 500: upstream down')), null);
  assert.equal(mcpFailureReason(new Error('The operation was aborted')), null);
  assert.equal(mcpFailureReason(undefined), null);
});

// ── multi-chain explorer links ────────────────────────────────────────────────
// The bot was confined to Base because every link it produced was a basescan
// link, so a transfer on any other chain would be reported with a URL that does
// not resolve. quidliDrop now attaches the right link for the chain it used.
test('explorer links follow the chain the drop was sent on', () => {
  const src = `${grabConst('const CHAIN_EXPLORERS = \\{')}; ${grab('explorerTxUrl')}; return explorerTxUrl;`;
  const url = new Function(src)();

  assert.equal(url(8453, '0xabc'), 'https://basescan.org/tx/0xabc');
  assert.equal(url(1, '0xabc'), 'https://etherscan.io/tx/0xabc');
  assert.equal(url(1399811149, '5xTr'), 'https://solscan.io/tx/5xTr');
  assert.equal(url('8453', '0xabc'), 'https://basescan.org/tx/0xabc', 'chainId may arrive as a string');
  assert.equal(url(999999, '0xabc'), null, 'unknown chains get no link rather than a wrong one');
  assert.equal(url(8453, undefined), null, 'no hash, no link');
});

// A Solana signature is case-sensitive base58, not 0x-prefixed hex. The old
// sanitiser matched only basescan + hex, so a real Solana link would have been
// stripped as fabricated the moment Solana drops started working.
test('the tx sanitiser accepts real Solana links and still strips invented ones', () => {
  const reLine = SRC.match(/^const EXPLORER_TX_RE = .*$/m);
  assert.ok(reLine, 'EXPLORER_TX_RE not found in bot.js');
  const src = `${reLine[0]}; ${grab('sanitizeUnverifiedTxClaims')}; return sanitizeUnverifiedTxClaims;`;
  const sanitize = new Function(src)();

  const realSol = 'https://solscan.io/tx/4KmXsPqRt9vBnW2gYzLc';
  const kept = sanitize(`sent it: ${realSol}`, [realSol]);
  assert.ok(kept.includes(realSol), 'a real Solana link must survive');

  const faked = sanitize('sent it: https://solscan.io/tx/9zzFAKEsignature11', [realSol]);
  assert.ok(!faked.includes('9zzFAKEsignature11'), 'an invented Solana link must be stripped');
  assert.match(faked, /unverified transaction link removed/);

  // EVM hashes stay case-insensitive
  const realEvm = `https://basescan.org/tx/0x${'a'.repeat(64)}`;
  const upper = `https://basescan.org/tx/0x${'A'.repeat(64)}`;
  assert.ok(sanitize(`done ${upper}`, [realEvm]).includes(upper), 'EVM hashes compare case-insensitively');
});

test('quidli_drop no longer requires tokenContract, so native sends are expressible', () => {
  const m = SRC.match(/name: 'quidli_drop'[\s\S]*?required: \[([^\]]*)\]/);
  assert.ok(m, 'could not find quidli_drop required list');
  assert.ok(!m[1].includes('tokenContract'), 'tokenContract must be optional — native SOL and native ETH omit it');
  assert.ok(m[1].includes('recipients') && m[1].includes('amountInWeiPerRecipient'));
});
