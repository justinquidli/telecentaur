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
  const editDistance = build(grab('editDistance'), 'editDistance');
  const agents = ['justin_quidli', 'justinahn', 'claude', 'hermes'];
  const suggest = (typed) => agents
    .map((n) => ({ n, d: editDistance(typed, n) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(x.n.length / 4)))
    .sort((a, b) => a.d - b.d)[0]?.n ?? null;

  assert.equal(suggest('justin_quidl'), 'justin_quidli');
  assert.equal(suggest('justinah'), 'justinahn');
  assert.equal(suggest('cluade'), 'claude');
  assert.equal(suggest('weather'), null, 'unrelated commands still fall through');
});
