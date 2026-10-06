import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_SCOPES, BOT_SCOPES, USER_SCOPES } from '../src/config.ts';
import { within } from '../src/lifecycle.ts';
import { RADAR_BOT, VERIFIED_RELAY } from '../src/relay.ts';
import { loadRelayTestConfig, startRelayTest } from '../src/relay-runtime.ts';
import type { RelayRuntimeDependencies } from '../src/relay-runtime.ts';
import { main } from '../src/start-relay-local.ts';
import type { SocketHandlers } from '../src/socket.ts';
import { SqliteQueue } from '../src/store.ts';
import type { Mention } from '../src/types.ts';
import { config, envelope } from './helpers.ts';

const credentials = { appToken: 'xapp-public-synthetic', userToken: 'xoxp-public-synthetic', botToken: 'xoxb-public-synthetic' };
const env = { RADAR_APP_ID: RADAR_BOT.appId, RADAR_CONFIRMED_SEPARATE_APP_ID: RADAR_BOT.appId, RADAR_BOT_USER_ID: RADAR_BOT.userId,
  RADAR_ALLOW_SLACK_CONNECTION: 'approved', RADAR_ALLOW_SLACK_READS: 'approved', RADAR_ALLOW_PRIVATE_RELAY: 'approved',
  RADAR_RELAY_CHANNEL_ID: VERIFIED_RELAY.channelId, RADAR_VERIFIED_APP_SCOPES: APP_SCOPES.join(',') };
const liveConfig = loadRelayTestConfig(env);
function fixture(options: { botExtraScope?: boolean; wrongUser?: boolean; wrongBot?: boolean; sendError?: boolean; mentions?: boolean } = {}) {
  const retained: Mention[] = [];
  class MetadataQueue extends SqliteQueue {
    override enqueue(mention: Mention, now: number): boolean { retained.push(mention); return super.enqueue(mention, now); }
  }
  const queue = new MetadataQueue(':memory:'); let closed = false; let reads = 0; let stores = 0; let auths = 0; let factories = 0; let acks = 0;
  const posts: { channel: string; text: string }[] = [];
  const port = { handlers: undefined as SocketHandlers | undefined, connects: 0,
    setHandlers(h: SocketHandlers) { this.handlers = h; },
    async connect() {
      this.connects++;
      if (!options.mentions) return;
      const source = envelope(`<@${config.userId}> synthetic-private-canary`, { api_app_id: RADAR_BOT.appId });
      for (const body of [envelope('No mention', { api_app_id: RADAR_BOT.appId, event_id: 'EvIGNORE' }),
        { ...source, event_id: 'EvRELAY', event: { ...source.event, channel: VERIFIED_RELAY.channelId } },
        { ...source, event_id: 'EvSELF', event: { ...source.event, user: config.userId } },
        { ...source, event_id: 'EvBOT', event: { ...source.event, user: RADAR_BOT.userId, subtype: 'bot_message', bot_id: RADAR_BOT.botId } },
        source, source, { ...source, event_id: 'EvDUPLICATE' }]) {
        this.handlers?.envelope({ type: 'events_api', body, async ack() { acks++; } });
      }
    },
    async disconnect() { this.handlers?.disconnected(); }
  };
  const dependencies: RelayRuntimeDependencies = {
    userPort() { factories++; return { async authTest() { auths++; return { team_id: config.teamId, user_id: options.wrongUser ? 'UOTHER' : config.userId, scopes: [...USER_SCOPES, 'identify'] }; },
      async replies() { reads++; assert.fail('Relay must not read thread content'); } }; },
    botPort() { factories++; return { async authTest() { auths++; return { team_id: config.teamId, user_id: options.wrongBot ? 'UOTHER' : RADAR_BOT.userId, bot_id: RADAR_BOT.botId, scopes: [...BOT_SCOPES, ...(options.botExtraScope ? ['search:read'] : [])] }; },
      async postMessage(input) { posts.push(input); if (options.sendError) throw new Error('synthetic-private-error'); } }; },
    socketPort() { factories++; return port; },
    store() { stores++; return { queue, close() { closed = true; } }; }
  };
  return { queue, port, dependencies, retained, posts, snapshot: () => ({ closed, reads, stores, auths, factories, acks }) };
}
test('real relay launcher requires separate relay approval/exact destination before credential prompts or factories', async () => {
  let prompts = 0; let starts = 0;
  for (const e of [{}, { ...env, RADAR_ALLOW_PRIVATE_RELAY: '' }, { ...env, RADAR_RELAY_CHANNEL_ID: 'COTHER' },
    { ...env, RADAR_TEST_MAX_SUMMARIES: '2' }, { ...env, RADAR_TEST_DURATION_MS: '600001' }]) {
    assert.equal(await main({ env: e, async readCredentials() { prompts++; return credentials; }, async start() { starts++; assert.fail(); }, report() {} }), 1);
  }
  assert.equal(prompts, 0); assert.equal(starts, 0);
  for (const overrides of [{ botUserId: 'UOTHER' }, { appId: 'AOTHER', confirmedSeparateAppId: 'AOTHER' }, { allowReads: false }, { allowConnection: false }, { relay: { ...VERIFIED_RELAY, allowRelay: false } }]) {
    const f = fixture();
    try { await assert.rejects(startRelayTest({ config: { ...liveConfig, ...overrides }, credentials, dependencies: f.dependencies })); assert.equal(f.snapshot().factories, 0); }
    finally { f.queue.close(); }
  }
});
test('real Socket-to-relay path acks retries, sends exactly one metadata-only source, and reads no thread', async () => {
  const f = fixture({ mentions: true }); const statuses: string[] = [];
  try {
    const handle = await startRelayTest({ config: liveConfig, credentials, dependencies: f.dependencies, pollMs: 10, onStatus: s => statuses.push(s) });
    await within(handle.done, 500);
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.channel, VERIFIED_RELAY.channelId);
    assert.match(f.posts[0]!.text, /^Radar source v1\nworkspace_id=TTEST00001\nchannel_id=CTEST123\n/);
    assert.equal(f.posts[0]!.text.includes('synthetic-private-canary'), false);
    assert.ok(f.retained.length); assert.ok(f.retained.every(m => m.text === ''));
    assert.equal(f.snapshot().reads, 0); assert.equal(f.snapshot().auths, 2); assert.equal(f.snapshot().acks, 7);
    assert.equal(f.queue.status('EvTEST123'), 'done'); assert.equal(f.queue.status('EvIGNORE'), undefined);
    assert.equal(f.queue.status('EvRELAY'), undefined); assert.equal(f.queue.status('EvSELF'), undefined); assert.equal(f.queue.status('EvBOT'), undefined);
    assert.equal(f.snapshot().closed, true); assert.ok(statuses.includes('sent')); assert.equal(statuses.at(-1), 'stopped');
  } finally { f.queue.close(); }
});
test('relay runtime stops after an ambiguous post without a second send or private error output', async () => {
  const f = fixture({ mentions: true, sendError: true }); const reports: string[] = [];
  try {
    assert.equal(await within(main({ env, async readCredentials() { return credentials; }, start: options => startRelayTest({ ...options, dependencies: f.dependencies, pollMs: 10 }), report: s => reports.push(s) }), 500), 0);
    assert.equal(f.posts.length, 1); assert.equal(f.queue.status('EvTEST123'), 'uncertain'); assert.equal(f.snapshot().closed, true);
    assert.ok(reports.includes('Radar relay: uncertain')); assert.equal(reports.join('\n').includes('synthetic-private-error'), false);
  } finally { f.queue.close(); }
});
test('wrong user/bot or extra bot permissions prevent relay queue creation and Socket connection', async () => {
  for (const options of [{ wrongUser: true }, { wrongBot: true }, { botExtraScope: true }]) {
    const f = fixture(options);
    try {
      await assert.rejects(startRelayTest({ config: liveConfig, credentials, dependencies: f.dependencies }));
      assert.equal(f.snapshot().stores, 0); assert.equal(f.port.connects, 0); assert.equal(f.posts.length, 0); assert.equal(f.snapshot().reads, 0);
    } finally { f.queue.close(); }
  }
});
test('explicit stop releases an idle relay runtime and refuses further intake', async () => {
  const f = fixture();
  try {
    const handle = await startRelayTest({ config: liveConfig, credentials, dependencies: f.dependencies });
    await within(handle.stop(), 500); assert.equal(f.snapshot().closed, true);
    f.port.handlers?.envelope({ type: 'events_api', body: envelope(undefined, { api_app_id: RADAR_BOT.appId }), async ack() { assert.fail(); } });
    assert.equal(f.queue.status('EvTEST123'), undefined); assert.equal(f.posts.length, 0);
  } finally { f.queue.close(); }
});
