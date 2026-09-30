/**
 * The send guardrail each user picks at /connect. The rule lives in code, not
 * the prompt: a rule the model holds is one a quoted message can talk it out of.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { holdReason, parseSendGuard, sendGuardPrompt, describeHeldAction, heldToolResult, createHeldActionStore } from '../held-actions.js';

const send = { tool: 'connect_drop' };

test('no guardrail chosen, or none: sends run, quote or not', () => {
  for (const guard of [null, 'none']) {
    assert.equal(holdReason({ ...send, guard }), null);
    assert.equal(holdReason({ ...send, guard, quotesOther: true }), null);
  }
});

test('all: every send waits', () => {
  assert.equal(holdReason({ ...send, guard: 'all' }), 'guard_all');
});

test('quotes: only a turn that quotes someone else waits', () => {
  assert.equal(holdReason({ ...send, guard: 'quotes' }), null);
  assert.equal(holdReason({ ...send, guard: 'quotes', quotesOther: true }), 'guard_quotes');
});

test('a document holds whatever the user picked', () => {
  assert.equal(holdReason({ ...send, guard: 'none', documentInContext: true }), 'document');
});

test('confirmed runs, and non-money tools are never held', () => {
  assert.equal(holdReason({ ...send, guard: 'all', confirmed: true }), null);
  assert.equal(holdReason({ tool: 'connect_lookup', guard: 'all', quotesOther: true, documentInContext: true }), null);
});

test('every money tool is covered, not just connect_drop', () => {
  for (const tool of ['schedule_drop', 'conditional_drop', 'create_watcher', 'create_pending_claim', 'bankr_agent', 'bankr_swap_and_drop']) {
    assert.equal(holdReason({ tool, guard: 'all' }), 'guard_all', tool);
  }
});

test('parseSendGuard reads the three choices and rejects anything else', () => {
  assert.equal(parseSendGuard('none'), 'none');
  assert.equal(parseSendGuard(' ALL '), 'all');
  assert.equal(parseSendGuard('quotes'), 'quotes');
  assert.equal(parseSendGuard(''), null);
  assert.equal(parseSendGuard('50'), null);
});

test('the prompt names all three commands', () => {
  const p = sendGuardPrompt('/');
  for (const c of ['/guard none', '/guard all', '/guard quotes']) assert.ok(p.includes(c), c);
});

test('the held notice and model result say why it was held', () => {
  const input = { chainId: 8453, amountInWeiPerRecipient: '1000000', recipients: [{ type: 'telegram', id: '1' }] };
  assert.match(describeHeldAction({ code: 'ABC123', tool: 'connect_drop', input, reason: 'guard_all' }), /you asked to confirm every send/);
  assert.match(describeHeldAction({ code: 'ABC123', tool: 'connect_drop', input, reason: 'guard_quotes' }), /quotes someone else/);
  assert.match(describeHeldAction({ code: 'ABC123', tool: 'connect_drop', input }), /a document is in this conversation/);
  assert.match(JSON.parse(heldToolResult('ABC123', null, 'guard_all')).message, /confirm every send/);
});

test('the reason survives in the store, so the pending list shows it', () => {
  const store = createHeldActionStore();
  const { code } = store.hold({ tool: 'connect_drop', input: {}, senderId: '1', channelId: '1', reason: 'guard_quotes' });
  assert.equal(store.listFor('1')[0].reason, 'guard_quotes');
  assert.ok(code);
});

// bot.js connects to Telegram on import, so its wiring is checked in source.
test('runTool holds on holdReason, with the user\'s own guard', () => {
  const src = readFileSync(new URL('../bot.js', import.meta.url), 'utf8');
  assert.match(src, /const guard = MONEY_TOOLS\.has\(name\) && !confirmed \? getSendGuard\(senderId\) : null;/);
  assert.match(src, /const holdWhy = holdReason\(\{ tool: name, confirmed, documentInContext, quotesOther, guard \}\);\n\s*if \(holdWhy\) \{/);
  assert.match(src, /tg\.command\('guard'/);
});

// ─── runTool, executed (extracted from bot.js with injected deps) ────────────

const HERE = new URL('../bot.js', import.meta.url);
function buildRunTool() {
  const src = readFileSync(HERE, 'utf8');
  const start = src.indexOf('async function runTool(');
  let i = src.indexOf('{', src.indexOf(') {', start) ) , depth = 0, end = i;
  for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
  const fnSrc = src.slice(start, end + 1);
  const calls = [];
  const deps = {
    BOT_OWNER_ID: 'owner', QUIDLI_API_KEY: 'host-key',
    MONEY_TOOLS: new Set(['connect_drop']), heldActions: createHeldActionStore(), describeHeldAction, heldToolResult,
    mcpToolNames: new Set(['connect_drop']), explorerTxUrl: (c, h) => (h ? `https://basescan.org/tx/${h}` : null),
    MCP_CONFIRM_TOOLS: new Set(), shutdown: { stopping: false, track: (p) => p },
    mcpCallTool: async (name) => { calls.push(name); return '{"httpStatus":201,"transferHash":"0xabc"}'; },
    mcpFailureReason: () => null, redactConnectMe: (t) => t, _pendingExplorerUrls: [],
    getUserBankrKey: () => null,
    holdReason, sendGuardPrompt,
    guards: {}, asked: new Set(),
    getSendGuard: (id) => deps.guards[String(id)] ?? null,
    claimSendGuardQuestion: (id) => (deps.asked.has(String(id)) ? false : (deps.asked.add(String(id)), true)),
  };
  const runTool = new Function(...Object.keys(deps), `${fnSrc}\nreturn runTool;`)(...Object.values(deps));
  return { runTool, calls, deps };
}
const drop = { chainId: 8453, amountInWeiPerRecipient: '1000000', recipients: [{ type: 'telegram', id: '9' }] };

test('runTool: guard quotes holds a quoting turn and runs a plain one', async () => {
  const { runTool, calls, deps } = buildRunTool();
  deps.guards['42'] = 'quotes';
  const notices = [];
  const held = JSON.parse(await runTool('connect_drop', drop, { senderId: 42, senderApiKey: 'k', currentChatId: 1, quotesOther: true, heldNotices: notices }));
  assert.equal(held.status, 'held_for_confirmation');
  assert.equal(calls.length, 0, 'nothing sent');
  assert.match(notices[0], /quotes someone else/);
  await runTool('connect_drop', drop, { senderId: 42, senderApiKey: 'k', currentChatId: 1 });
  assert.equal(calls.length, 1, 'plain turn sends');
});

test('runTool: guard all holds every send; none sends', async () => {
  const { runTool, calls, deps } = buildRunTool();
  deps.guards['42'] = 'all';
  assert.equal(JSON.parse(await runTool('connect_drop', drop, { senderId: 42, senderApiKey: 'k', currentChatId: 1 })).status, 'held_for_confirmation');
  deps.guards['42'] = 'none';
  await runTool('connect_drop', drop, { senderId: 42, senderApiKey: 'k', currentChatId: 1, quotesOther: true });
  assert.equal(calls.length, 1);
});

test('runTool: a user who never chose is asked once, and that send still runs', async () => {
  const { runTool, calls } = buildRunTool();
  const n1 = [], n2 = [];
  await runTool('connect_drop', drop, { senderId: 42, senderApiKey: 'k', currentChatId: 1, heldNotices: n1 });
  await runTool('connect_drop', drop, { senderId: 42, senderApiKey: 'k', currentChatId: 1, heldNotices: n2 });
  assert.equal(calls.length, 2, 'both sends ran');
  assert.equal(n1.length, 1);
  assert.match(n1[0], /\/guard quotes/);
  assert.equal(n2.length, 0, 'asked only once');
});

test('runTool: a keyless sender is not asked (their send cannot run anyway)', async () => {
  const { runTool } = buildRunTool();
  const n = [];
  await runTool('connect_drop', drop, { senderId: 42, senderApiKey: null, currentChatId: 1, heldNotices: n }).catch(() => {});
  assert.equal(n.length, 0);
});
