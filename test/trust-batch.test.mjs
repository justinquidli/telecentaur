/**
 * trust_many: trust several people behind ONE /confirm. Connect attests one
 * identity per call, so the bot holds the list and loops on confirm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MONEY_TOOLS, createHeldActionStore, describeHeldAction, heldToolResult, holdReason, sendGuardPrompt,
  TRUST_BATCH_TOOL, TRUST_BATCH_MAX, validateTrustBatch, isTrustAction,
  createRecordQueue, createVerifiedLinkStore, formatOutcomeRecord, parseConfirmPayload,
} from '../held-actions.js';
import { MCP_CONFIRM_TOOLS } from '../connect-mcp.js';

const SRC = readFileSync(new URL('../bot.js', import.meta.url), 'utf8');
function fnSrc(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  let i = SRC.indexOf(') {', start) + 2, depth = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) break; }
  return SRC.slice(start, i + 1);
}

function buildRunTool({ mcp } = {}) {
  const calls = [];
  const deps = {
    BOT_OWNER_ID: 'owner', QUIDLI_API_KEY: 'host-key',
    MONEY_TOOLS, heldActions: createHeldActionStore(), describeHeldAction, heldToolResult,
    mcpToolNames: new Set(['connect_trust_create', 'connect_trust_revoke']),
    MCP_CONFIRM_TOOLS, shutdown: { stopping: false, track: (p) => p },
    mcpCallTool: mcp ?? (async (name, input, key) => { calls.push({ name, input, key }); return '{"httpStatus":201,"uid":"0x1"}'; }),
    mcpFailureReason: () => null, redactConnectMe: (t) => t, _pendingExplorerUrls: [],
    explorerTxUrl: () => null, getUserBankrKey: () => null,
    holdReason, sendGuardPrompt, TRUST_BATCH_TOOL, TRUST_BATCH_MAX, validateTrustBatch, isTrustAction,
    getSendGuard: () => 'none', claimSendGuardQuestion: () => false,
  };
  const runTool = new Function(...Object.keys(deps), `${fnSrc('runTool')}\nreturn runTool;`)(...Object.values(deps));
  return { runTool, calls, deps };
}

const team = { targets: [{ type: 'telegram', id: '1' }, { type: 'telegram', id: '2' }, { type: 'github', username: 'alice' }], level: 80, context: 'team:quidli' };

test('a batch is held behind one code and writes nothing until confirmed', async () => {
  const { runTool, calls, deps } = buildRunTool();
  const notices = [];
  const out = JSON.parse(await runTool(TRUST_BATCH_TOOL, team, { senderId: 42, senderApiKey: 'k', currentChatId: -1, heldNotices: notices }));
  assert.equal(out.status, 'held_for_confirmation');
  assert.equal(calls.length, 0);
  assert.equal(deps.heldActions.listFor('42').length, 1, 'one held action for the whole list');
  assert.match(notices[0], /Trust 3 people on Base/);
  assert.match(notices[0], /team:quidli/);
  assert.match(notices[0], /\/confirm/);
});

test('held whatever the send guardrail says — trust is not a send', async () => {
  const { runTool, calls, deps } = buildRunTool();
  deps.getSendGuard = () => 'none';
  JSON.parse(await runTool(TRUST_BATCH_TOOL, team, { senderId: 42, senderApiKey: 'k' }));
  assert.equal(calls.length, 0);
});

test('confirmed: one connect_trust_create per person, same level and context, sender key', async () => {
  const { runTool, calls } = buildRunTool();
  const out = JSON.parse(await runTool(TRUST_BATCH_TOOL, team, { senderId: 42, senderApiKey: 'k', confirmed: true }));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.name === 'connect_trust_create' && c.key === 'k' && c.input.level === 80 && c.input.context === 'team:quidli'));
  assert.deepEqual(calls.map((c) => c.input.to), team.targets);
  assert.deepEqual([out.success, out.trusted, out.total], [true, 3, 3]);
});

test('a failure part way through is reported per person, and the rest still run', async () => {
  let n = 0;
  const { runTool } = buildRunTool({ mcp: async () => { n++; if (n === 2) throw new Error('MCP tool error: insufficient gas'); return '{"httpStatus":201}'; } });
  const out = JSON.parse(await runTool(TRUST_BATCH_TOOL, team, { senderId: 42, senderApiKey: 'k', confirmed: true }));
  assert.equal(n, 3);
  assert.deepEqual([out.success, out.trusted, out.total], [false, 2, 3]);
  assert.equal(out.failed[0].to, 'telegram:2');
  assert.match(out.failed[0].error, /insufficient gas/);
});

test('an HTTP error status in the result counts as a failure', async () => {
  const { runTool } = buildRunTool({ mcp: async () => '{"httpStatus":400,"message":"signer not enrolled"}' });
  const out = JSON.parse(await runTool(TRUST_BATCH_TOOL, { targets: [{ type: 'telegram', id: '1' }], level: 50 }, { senderId: 42, senderApiKey: 'k', confirmed: true }));
  assert.deepEqual([out.success, out.trusted], [false, 0]);
});

test('invalid batches are refused before anything is held', async () => {
  const { runTool, deps } = buildRunTool();
  const tooMany = { targets: Array.from({ length: TRUST_BATCH_MAX + 1 }, (_, i) => ({ type: 'telegram', id: String(i) })), level: 50 };
  for (const bad of [{ targets: [], level: 50 }, tooMany, { ...team, level: 0 }, { ...team, level: 101 },
    { targets: [{ type: 'telegram', id: '1' }, { type: 'telegram', id: '1' }], level: 50 }, { targets: [{ type: 'telegram' }], level: 50 }]) {
    const out = JSON.parse(await runTool(TRUST_BATCH_TOOL, bad, { senderId: 42, senderApiKey: 'k' }));
    assert.equal(out.status, 'refused', JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(deps.heldActions.listFor('42').length, 0);
});

test('keyless non-owner is refused, never held, never given the host key', async () => {
  const { runTool, calls, deps } = buildRunTool();
  const out = await runTool(TRUST_BATCH_TOOL, team, { senderId: 42, senderApiKey: null });
  assert.match(out, /needs your own Quidli key/);
  assert.equal(deps.heldActions.listFor('42').length, 0);
  assert.equal(calls.length, 0);
});

test('refused while the bot shuts down', async () => {
  const { runTool, deps } = buildRunTool();
  deps.shutdown.stopping = true;
  const out = JSON.parse(await runTool(TRUST_BATCH_TOOL, team, { senderId: 42, senderApiKey: 'k' }));
  assert.equal(out.status, 'refused');
});

test('/confirm reports partial success with who failed, and records it', async () => {
  const deps = {
    heldActions: createHeldActionStore(), heldOutcomeRecords: createRecordQueue(), verifiedTxLinks: createVerifiedLinkStore(),
    describeHeldAction, formatOutcomeRecord, parseConfirmPayload, MCP_CONFIRM_TOOLS, TRUST_BATCH_TOOL,
    getUserApiKey: () => 'k', _pendingExplorerUrls: [],
    trackedRunTool: async () => JSON.stringify({ success: false, trusted: 2, total: 3, failed: [{ to: 'telegram:2', error: 'insufficient gas' }], message: 'Trusted 2 of 3. Failed: telegram:2' }),
  };
  const fn = new Function(...Object.keys(deps), `${fnSrc('handleConfirmCommand')}\nreturn handleConfirmCommand;`)(...Object.values(deps));
  const replies = [];
  const ctx = { from: { id: 42 }, payload: '', reply: async (t) => { replies.push(t); return { chat: { id: 1 }, message_id: 1 }; }, telegram: { editMessageText: async (_c, _m, _i, t) => replies.push(t) } };
  const { code } = deps.heldActions.hold({ tool: TRUST_BATCH_TOOL, input: team, senderId: '42', channelId: 1, contextId: '1' });
  await fn({ ...ctx, payload: code }, 'confirm');
  assert.match(replies.at(-1), /⚠️ .*Trusted 2 of 3/s);
  assert.match(replies.at(-1), /telegram:2: insufficient gas/);
  assert.match(deps.heldOutcomeRecords.take('1')[0], /ALREADY RUN \(partially: Trusted 2 of 3/);
});

test('the model is offered the tool and told to use it for groups', () => {
  assert.match(SRC, /name: TRUST_BATCH_TOOL,/);
  assert.match(SRC, /call trust_many ONCE with all of them/);
});
