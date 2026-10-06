import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_SCOPES, BOT_SCOPES, USER_SCOPES } from '../src/config.ts';
import { loadHostedConfig, loadHostedCredentials, startHosted } from '../src/hosted.ts';
import { main } from '../src/start-hosted.ts';
import { RADAR_BOT, VERIFIED_RELAY } from '../src/relay.ts';
import { within } from '../src/lifecycle.ts';
import type { RelayRuntimeDependencies } from '../src/relay-runtime.ts';
import type { SocketHandlers } from '../src/socket.ts';
import { SqliteQueue } from '../src/store.ts';
import { envelope } from './helpers.ts';
import { TARGET } from '../src/types.ts';

const credentials = { appToken: 'xapp-public-fixture', userToken: 'xoxp-public-fixture', botToken: 'xoxb-public-fixture' };
const env = { RADAR_TEAM_ID: TARGET.teamId, RADAR_USER_ID: TARGET.userId,
  RADAR_APP_ID: RADAR_BOT.appId, RADAR_CONFIRMED_SEPARATE_APP_ID: RADAR_BOT.appId, RADAR_BOT_USER_ID: RADAR_BOT.userId,
  RADAR_ALLOW_SLACK_CONNECTION: 'approved', RADAR_ALLOW_SLACK_READS: 'approved', RADAR_ALLOW_PRIVATE_RELAY: 'approved',
  RADAR_RELAY_CHANNEL_ID: VERIFIED_RELAY.channelId, RADAR_VERIFIED_APP_SCOPES: APP_SCOPES.join(','),
  RADAR_ALLOW_CONTINUOUS: 'approved', RADAR_DEPLOYMENT_APPROVED: 'approved', RADAR_DATA_DIRECTORY: '/var/lib/thread-watch' };
const hosted = loadHostedConfig(env);
function fixture() {
  const queue = new SqliteQueue(':memory:'); let closed = false; let factories = 0;
  const posts: string[] = []; let handlers: SocketHandlers | undefined;
  const dependencies: RelayRuntimeDependencies = {
    userPort() { factories++; return {
      async authTest() { return { team_id: hosted.teamId, user_id: hosted.userId, scopes: [...USER_SCOPES, 'identify'] }; },
      async replies() { assert.fail('Hosted relay must never fetch source content'); }
    }; },
    botPort() { factories++; return {
      async authTest() { return { team_id: hosted.teamId, user_id: RADAR_BOT.userId, bot_id: RADAR_BOT.botId, scopes: [...BOT_SCOPES] }; },
      async postMessage(input) { assert.equal(input.channel, VERIFIED_RELAY.channelId); posts.push(input.text); }
    }; },
    socketPort() { factories++; return { setHandlers(h) { handlers = h; }, async connect() {}, async disconnect() {} }; },
    store() { factories++; return { queue, close() { closed = true; } }; }
  };
  function deliver(index: number, text: string, overrides: Record<string, unknown> = {}) {
    const body = envelope(text, { api_app_id: RADAR_BOT.appId, event_id: `EvHOSTED${index}` });
    body.event.ts = `1791029813.${String(index).padStart(6, '0')}`;
    Object.assign(body.event, overrides);
    handlers!.envelope({ type: 'events_api', body, async ack() {} });
  }
  return { queue, posts, dependencies, deliver, fatal() { handlers!.fatal(); }, snapshot: () => ({ closed, factories }) };
}
test('hosted gates reject altered identity, storage, scopes and missing continuous/deployment approvals before factories', async () => {
  const f = fixture();
  try {
    for (const override of [{ continuousApproved: false }, { deploymentApproved: false }, { dataDirectory: '/tmp/queue' },
      { botUserId: 'UOTHER' }, { verifiedAppScopes: ['connections:write', 'authorizations:read'] }, { relay: { ...hosted.relay, channelId: 'COTHER' } }]) {
      await assert.rejects(startHosted({ config: { ...hosted, ...override }, credentials, dependencies: f.dependencies }));
    }
    assert.equal(f.snapshot().factories, 0);
    let starts = 0;
    assert.equal(await main({ env: {}, start: async () => { starts++; assert.fail(); }, report() {} }), 78);
    assert.equal(starts, 0);
  } finally { f.queue.close(); }
});
test('hosted Socket routing forwards watched posts without mentions and later nonmention replies in a tracked thread', async () => {
  const f = fixture();
  const broader = loadHostedConfig({ ...env, RADAR_WATCH_CHANNEL_IDS: 'CTESTWATCH1', RADAR_ALLOW_CHANNEL_MONITORING: 'approved', RADAR_FOLLOW_MENTION_THREADS: 'approved' });
  const handle = await startHosted({ config: broader, credentials, dependencies: f.dependencies, pollMs: 10 });
  try {
    f.deliver(1, 'Private engineering fixture', { channel: 'CTESTWATCH1', channel_type: 'group' });
    f.deliver(2, `<@${hosted.userId}> discussion`);
    f.deliver(3, 'Later reply without mention', { thread_ts: '1791029813.000002' });
    f.deliver(4, 'Unrelated discussion');
    await within(new Promise<void>(resolve => {
      const interval = setInterval(() => { if (f.posts.length === 3) { clearInterval(interval); resolve(); } }, 5);
    }), 1000);
    assert.equal(f.posts.length, 3);
    assert.ok(f.posts[0]!.endsWith('reason=watched_channel'));
    assert.ok(f.posts[1]!.endsWith('reason=mention'));
    assert.ok(f.posts[2]!.endsWith('reason=followed_thread'));
    assert.ok(f.posts.every(text => !text.includes('fixture') && !text.includes('Later reply')));
    assert.equal(f.queue.status('EvHOSTED4'), undefined);
  } finally { await handle.stop(); f.queue.close(); }
});
test('hosted preflight validates only nonsecret gates and leaves credential references untouched', async () => {
  const refs = { ...env, SLACK_APP_TOKEN: '{{synthetic-reference}}' }; let starts = 0;
  assert.equal(await main({ env: refs, preflight: true, start: async () => { starts++; assert.fail(); }, report() {} }), 0);
  assert.equal(starts, 0); assert.equal(refs.SLACK_APP_TOKEN, '{{synthetic-reference}}');
  const injected: Record<string, string | undefined> = { ...env, SLACK_APP_TOKEN: credentials.appToken, SLACK_USER_TOKEN: credentials.userToken, SLACK_BOT_TOKEN: credentials.botToken };
  assert.deepEqual(loadHostedCredentials(injected), credentials);
  assert.ok(!('SLACK_APP_TOKEN' in injected) && !('SLACK_USER_TOKEN' in injected) && !('SLACK_BOT_TOKEN' in injected));
});
test('continuous hosted worker handles multiple distinct mentions, dedupes and stays running until stopped', async () => {
  const f = fixture(); const statuses: string[] = []; let finished = false;
  try {
    const handle = await startHosted({ config: hosted, credentials, dependencies: f.dependencies, pollMs: 10,
      onStatus: status => statuses.push(status) });
    void handle.done.then(() => { finished = true; });
    f.deliver(1, `<@${hosted.userId}> private-fixture-one`);
    f.deliver(1, `<@${hosted.userId}> duplicate`);
    f.deliver(2, 'Please do a task tomorrow?');
    f.deliver(3, `<@${hosted.userId}> private-fixture-two`);
    await within(new Promise<void>(resolve => {
      const interval = setInterval(() => { if (f.posts.length === 2) { clearInterval(interval); resolve(); } }, 5);
    }), 1000);
    assert.equal(f.posts.length, 2); assert.equal(finished, false);
    assert.equal(f.queue.status('EvHOSTED2'), undefined);
    assert.ok(f.posts.every(text => text.startsWith('Radar source v2\n') && !text.includes('private-fixture')));
    await within(handle.stop(), 500);
    assert.equal(f.snapshot().closed, true); assert.equal(statuses.at(-1), 'stopped');
  } finally { f.queue.close(); }
});
test('fatal hosted ingress closes storage and returns nonzero for supervisor recovery without private diagnostics', async () => {
  const f = fixture(); const reports: string[] = [];
  try {
    const code = await within(main({ env: { ...env, SLACK_APP_TOKEN: credentials.appToken, SLACK_USER_TOKEN: credentials.userToken, SLACK_BOT_TOKEN: credentials.botToken },
      start: async options => {
        const handle = await startHosted({ ...options, dependencies: f.dependencies, pollMs: 10 });
        setImmediate(() => f.fatal()); return handle;
      }, report: s => reports.push(s), record() {} }), 500);
    assert.equal(code, 1); assert.equal(f.snapshot().closed, true);
    assert.ok(reports.includes('Radar hosted: failed [runtime/unexpected]'));
    assert.ok(reports.every(text => !text.includes('xox') && !text.includes('xapp')));
  } finally { f.queue.close(); }
});
