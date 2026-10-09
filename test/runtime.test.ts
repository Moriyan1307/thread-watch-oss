import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { APP_SCOPES, BOT_SCOPES, USER_SCOPES, loadLocalConfig } from '../src/config.ts';
import type { LocalConfig } from '../src/config.ts';
import { readHiddenToken } from '../src/credentials.ts';
import { delay, within } from '../src/lifecycle.ts';
import { openLocalStore } from '../src/local-store.ts';
import { startLocalTest } from '../src/runtime.ts';
import type { RuntimeDependencies } from '../src/runtime.ts';
import { main } from '../src/start-local.ts';
import { SqliteQueue } from '../src/store.ts';
import { workOne } from '../src/worker.ts';
import { ingest } from '../src/intake.ts';
import { config, envelope } from './helpers.ts';
import type { SocketHandlers, SocketPort } from '../src/socket.ts';

const credentials = { appToken: 'xapp-public-synthetic', userToken: 'xoxp-public-synthetic', botToken: 'xoxb-public-synthetic' };
const env = { RADAR_APP_ID: config.appId, RADAR_CONFIRMED_SEPARATE_APP_ID: config.appId, RADAR_BOT_USER_ID: 'URADARBOT',
  RADAR_ALLOW_SLACK_CONNECTION: 'approved', RADAR_ALLOW_SLACK_READS: 'approved', RADAR_ALLOW_PRIVATE_DM: 'approved',
  RADAR_VERIFIED_APP_SCOPES: APP_SCOPES.join(',') };
const liveConfig: LocalConfig = loadLocalConfig(env);
function fixture(options: { wrongReader?: boolean; wrongBot?: boolean; scopes?: readonly string[]; userError?: unknown; botError?: unknown; connectError?: unknown; sendError?: boolean; onConnect?: (port: SocketPort & { handlers?: SocketHandlers; connects: number }) => void } = {}) {
  const queue = new SqliteQueue(':memory:'); let closed = false; let reads = 0; let sends = 0; let auths = 0; let stores = 0;
  const port = { handlers: undefined as SocketHandlers | undefined, connects: 0, stops: 0,
    setHandlers(h: SocketHandlers) { this.handlers = h; },
    async connect() { this.connects++; if (options.connectError) throw options.connectError; options.onConnect?.(this); },
    async disconnect() { this.stops++; this.handlers?.disconnected(); }
  };
  const dependencies: RuntimeDependencies = {
    userPort() { return { async authTest() { auths++; if (options.userError) throw options.userError; return { team_id: config.teamId, user_id: options.wrongReader ? 'UOTHER' : config.userId, scopes: [...(options.scopes ?? USER_SCOPES)] }; },
      async replies() { reads++; return { messages: [{ text: 'Synthetic context', ts: '1791029813.997859' }] }; } }; },
    botPort() { return { async authTest() { auths++; if (options.botError) throw options.botError; return { team_id: config.teamId, bot_id: 'BTEST', user_id: options.wrongBot ? 'UOTHER' : liveConfig.botUserId, scopes: [...BOT_SCOPES] }; },
      async openDm() { return 'DTEST123'; }, async postDm() { sends++; if (options.sendError) throw new Error('synthetic-secret-error'); } }; },
    socketPort() { return port; }, store() { stores++; return { queue, close() { closed = true; } }; }
  };
  return { dependencies, port, queue, snapshot: () => ({ closed, reads, sends, auths, stores }) };
}
test('startup defaults and every approval/identity/configuration gate fail before credential prompts, factories or auth', async () => {
  let prompts = 0; let starts = 0;
  const reports: string[] = [];
  assert.equal(await main({ env: {}, async readCredentials() { prompts++; return credentials; }, async start() { starts++; throw new Error('unexpected'); }, report: s => reports.push(s) }), 1);
  assert.equal(prompts, 0); assert.equal(starts, 0);
  for (const overrides of [{ allowConnection: false }, { allowReads: false }, { allowPrivateDelivery: false }, { confirmedSeparateAppId: 'AOTHER' },
    { teamId: 'TOTHER' }, { userId: 'UOTHER' }, { botUserId: config.userId }, { maxSummaries: 0 }, { durationMs: 3_600_001 }, { verifiedAppScopes: ['connections:write', 'authorizations:read'] }]) {
    const f = fixture();
    try { await assert.rejects(startLocalTest({ config: { ...liveConfig, ...overrides }, credentials, dependencies: f.dependencies }));
      assert.equal(f.snapshot().auths, 0); assert.equal(f.snapshot().stores, 0); assert.equal(f.port.connects, 0); }
    finally { f.queue.close(); }
  }
});
test('launcher reports the exact failing startup stage/reason, suppresses SDK payloads, and releases resources on Socket failure', async () => {
  const sensitive = 'synthetic-private-material-never-print';
  const apiError = (error: string) => ({ code: 'slack_webapi_platform_error', data: { error, access_token: sensitive, text: sensitive }, message: sensitive });
  for (const [options, expected] of [
    [{ userError: apiError('invalid_auth') }, 'user_auth/invalid_auth'],
    [{ wrongReader: true }, 'user_auth/wrong_identity'],
    [{ scopes: [] }, 'user_auth/scope_metadata_missing'],
    [{ scopes: [...USER_SCOPES, 'search:read'] }, 'user_auth/scopes_mismatch'],
    [{ botError: apiError('token_revoked') }, 'bot_auth/token_revoked'],
    [{ wrongBot: true }, 'bot_auth/wrong_identity'],
    [{ connectError: apiError('missing_scope') }, 'socket/missing_scope'],
    [{ userError: { code: 'slack_webapi_request_error', message: sensitive, original: { message: sensitive } } }, 'user_auth/network']
  ] as const) {
    const f = fixture(options); const reports: string[] = [];
    try {
      const exit = await main({ env, async readCredentials() { return credentials; },
        start: options => startLocalTest({ ...options, dependencies: f.dependencies }), report: s => reports.push(s) });
      assert.equal(exit, 1); assert.ok(reports.join('\n').includes(`[${expected}]`));
      assert.equal(reports.join('\n').includes(sensitive), false);
      assert.equal(f.snapshot().reads, 0); assert.equal(f.snapshot().sends, 0);
      assert.equal(f.snapshot().stores, expected.startsWith('socket/') ? 1 : 0);
      if (expected.startsWith('socket/')) assert.equal(f.snapshot().closed, true);
    } finally { f.queue.close(); }
  }
});
test('wrong reader, wrong Radar bot, missing scope metadata and excess grants prevent Socket connection and queue creation', async () => {
  for (const options of [{ wrongReader: true }, { wrongBot: true }, { scopes: [] }, { scopes: [...USER_SCOPES, 'search:read'] }]) {
    const f = fixture(options);
    try { await assert.rejects(startLocalTest({ config: liveConfig, credentials, dependencies: f.dependencies }));
      assert.equal(f.snapshot().stores, 0); assert.equal(f.port.connects, 0); assert.equal(f.snapshot().sends, 0); }
    finally { f.queue.close(); }
  }
});
test('runtime handles an SDK-shaped mention end to end, reads only matches, sends once, and shuts down at its summary bound', async () => {
  const f = fixture({ onConnect(port) {
    port.handlers?.envelope({ type: 'events_api', body: envelope('No mention', { event_id: 'EvIGNORE' }), async ack() {} });
    port.handlers?.envelope({ type: 'events_api', body: envelope(), async ack() {} });
  } }); const statuses: string[] = [];
  try {
    const handle = await startLocalTest({ config: liveConfig, credentials, dependencies: f.dependencies, pollMs: 10, onStatus: s => statuses.push(s) });
    await within(handle.done, 500);
    assert.equal(f.snapshot().reads, 1); assert.equal(f.snapshot().sends, 1); assert.equal(f.snapshot().closed, true);
    assert.equal(f.queue.status('EvTEST123'), 'done'); assert.equal(f.queue.status('EvIGNORE'), undefined);
    assert.ok(statuses.includes('sent')); assert.equal(statuses.at(-1), 'stopped'); await handle.stop();
  } finally { f.queue.close(); }
});
test('full runtime accepts Slack implicit identify on the reader while retaining one-summary and matching-only bounds', async () => {
  const f = fixture({ scopes: [...USER_SCOPES, 'identify'], onConnect(port) {
    port.handlers?.envelope({ type: 'events_api', body: envelope(), async ack() {} });
  } });
  try {
    const handle = await startLocalTest({ config: liveConfig, credentials, dependencies: f.dependencies, pollMs: 10 });
    await within(handle.done, 500);
    assert.equal(f.snapshot().auths, 2); assert.equal(f.snapshot().reads, 1); assert.equal(f.snapshot().sends, 1);
    assert.equal(f.snapshot().closed, true); assert.equal(f.queue.status('EvTEST123'), 'done');
  } finally { f.queue.close(); }
});
test('runtime reconnects after a refresh, then receives work; ambiguous delivery stops the local test without another post', async () => {
  const f = fixture({ sendError: true, onConnect(port) {
    if (port.connects === 2) port.handlers?.envelope({ type: 'events_api', body: envelope(), async ack() {} });
  } });
  try {
    const handle = await startLocalTest({ config: liveConfig, credentials, dependencies: f.dependencies, pollMs: 10 });
    f.port.handlers?.disconnected(); await within(handle.done, 500);
    assert.equal(f.port.connects, 2); assert.equal(f.snapshot().sends, 1); assert.equal(f.queue.status('EvTEST123'), 'uncertain');
  } finally { f.queue.close(); }
});
test('explicit stop interrupts idle waits and prevents post-stop intake; a duration limit also stops an idle runtime', async () => {
  const f = fixture();
  try {
    const handle = await startLocalTest({ config: liveConfig, credentials, dependencies: f.dependencies });
    await within(handle.stop(), 500); assert.equal(f.snapshot().closed, true); assert.equal(f.snapshot().sends, 0);
    f.port.handlers?.envelope({ type: 'events_api', body: envelope(), async ack() { assert.fail(); } });
    assert.equal(f.queue.status('EvTEST123'), undefined);
  } finally { f.queue.close(); }
  const timed = fixture();
  try {
    const handle = await startLocalTest({ config: { ...liveConfig, durationMs: 1_000 }, credentials, dependencies: timed.dependencies, pollMs: 10 });
    await within(handle.done, 1_500); assert.equal(timed.snapshot().closed, true);
  } finally { timed.queue.close(); }
});
test('cancellation during context read prevents a new send and preserves retryable work', async () => {
  const queue = new SqliteQueue(':memory:'); const controller = new AbortController(); let sends = 0;
  try {
    ingest(envelope(), config, queue, 0);
    assert.equal(await workOne({ store: queue, clock: () => 0, allowPrivateDelivery: true, signal: controller.signal,
      reader: { async fetchThread() { controller.abort(); return { messages: [], truncated: false }; } },
      sink: { async sendPrivate() { sends++; } } }), 'retry');
    assert.equal(sends, 0); assert.equal(queue.status('EvTEST123'), 'pending');
  } finally { queue.close(); }
});
test('exclusive local queue lock prevents a second process from recovering active work; retention expires queued text', () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'radar-runtime-')), 'data');
  const store = openLocalStore(directory);
  try {
    assert.equal(statSync(directory).mode & 0o777, 0o700); assert.throws(() => openLocalStore(directory));
    ingest(envelope(), config, store.queue, 0); assert.equal(store.queue.expire(86_400_001, 86_400_000), 1);
    store.close(); const second = openLocalStore(directory); second.close();
  } finally { store.close(); rmSync(join(directory, '..'), { recursive: true, force: true }); }
});
test('hidden credential input never echoes values, restores terminal mode, rejects non-TTY input and cancellation', async () => {
  class Input extends EventEmitter { isTTY = true; isRaw = false; paused = false;
    setRawMode(raw: boolean) { this.isRaw = raw; } resume() {} pause() { this.paused = true; } }
  const input = new Input(); const writes: string[] = []; const output = { isTTY: true, write: (s: string) => {
    if (s.includes('(hidden):')) assert.equal(input.isRaw, true, 'Echo must be disabled when a paste prompt is visible');
    writes.push(s);
  } };
  const pending = readHiddenToken('Synthetic token', input, output);
  input.emit('data', Buffer.from('xapp-public-synthetic\r'));
  assert.equal(await pending, 'xapp-public-synthetic'); assert.equal(input.isRaw, false); assert.equal(input.paused, true);
  assert.equal(writes.join('').includes('xapp-public-synthetic'), false);
  input.isTTY = false; await assert.rejects(readHiddenToken('Synthetic', input, output)); input.isTTY = true;
  const abort = new AbortController(); const cancelled = readHiddenToken('Synthetic', input, output, abort.signal);
  abort.abort(); await assert.rejects(cancelled); assert.equal(input.isRaw, false);
  const signal = new AbortController(); const sleep = delay(60_000, signal.signal); signal.abort(); await sleep;
});
test('local runtime rejects symlink data/queue paths, including dangling links', () => {
  const root = mkdtempSync(join(tmpdir(), 'radar-path-test-'));
  try {
    const directory = join(root, 'data'); symlinkSync(join(root, 'absent'), directory);
    assert.throws(() => openLocalStore(directory)); rmSync(directory);
    mkdirSync(directory, { mode: 0o700 }); symlinkSync(join(root, 'absent.sqlite'), join(directory, 'queue.sqlite'));
    assert.throws(() => openLocalStore(directory));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
