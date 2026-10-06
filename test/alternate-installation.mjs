// Invoked by publication.test.ts with a second synthetic installation and fresh DB.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TARGET } from '../src/types.ts';
import { USER_SCOPES, BOT_SCOPES } from '../src/config.ts';
import { loadHostedConfig, startHosted } from '../src/hosted.ts';
import { RADAR_BOT, VERIFIED_RELAY } from '../src/relay.ts';
import { SqliteQueue } from '../src/store.ts';

const config = loadHostedConfig(process.env);
assert.equal(TARGET.teamId, 'TSECOND001');
assert.equal(TARGET.userId, 'USECOND001');
let handlers; let queue; let acks = 0;
const posts = [];
const handle = await startHosted({ config, pollMs: 10,
  credentials: { appToken: 'xapp-public-fixture', userToken: 'xoxp-public-fixture', botToken: 'xoxb-public-fixture' },
  dependencies: {
    userPort() { return {
      async authTest() { return { team_id: config.teamId, user_id: config.userId, scopes: [...USER_SCOPES] }; },
      async replies() { assert.fail('Continuous relay must not fetch source content'); }
    }; },
    botPort() { return {
      async authTest() { return { team_id: config.teamId, user_id: RADAR_BOT.userId, bot_id: RADAR_BOT.botId, scopes: [...BOT_SCOPES] }; },
      async postMessage(input) { assert.equal(input.channel, VERIFIED_RELAY.channelId); posts.push(input.text); }
    }; },
    socketPort() { return { setHandlers(h) { handlers = h; }, async connect() {}, async disconnect() {} }; },
    store() { queue = new SqliteQueue(process.argv[2]); return { queue, close() { queue.close(); } }; }
  }
});
function deliver(index, channel, text, extra = {}, team = config.teamId) {
  handlers.envelope({ type: 'events_api', body: {
    type: 'event_callback', team_id: team, api_app_id: config.appId, event_id: 'EvSECOND' + index,
    authorizations: [{ team_id: team, user_id: config.userId, is_bot: false }],
    event: { type: 'message', channel_type: 'channel', channel, user: 'UHUMANOTHER',
      ts: '1791029813.' + String(index).padStart(6, '0'), text, ...extra }
  }, async ack() { acks++; } });
}
try {
  deliver(1, 'CSECONDWATCH', 'PRIVATE_CANARY informational post');
  deliver(2, 'CSECONDTHREAD', '<@USECOND001> PRIVATE_CANARY mention');
  deliver(2, 'CSECONDTHREAD', '<@USECOND001> duplicate');
  deliver(3, 'CSECONDTHREAD', 'PRIVATE_CANARY later reply', { thread_ts: '1791029813.000002' });
  deliver(4, 'CSECONDTHREAD', 'unrelated question?');
  deliver(5, 'CSECONDWATCH', 'wrong workspace', {}, 'TOTHER');
  deliver(6, VERIFIED_RELAY.channelId, '<@USECOND001> loop');
  for (let i = 0; i < 200 && posts.length < 3; i++) await delay(10);
  assert.equal(posts.length, 3); assert.equal(acks, 7);
  assert.deepEqual(posts.map(p => p.split('\n').at(-1)), ['reason=watched_channel', 'reason=mention', 'reason=followed_thread']);
  assert.ok(posts.every(p => p.startsWith('Radar source v2\nworkspace_id=TSECOND001\n') && !p.includes('PRIVATE_CANARY')));
  assert.equal(queue.status('EvSECOND4'), undefined); assert.equal(queue.status('EvSECOND5'), undefined);
  assert.equal(queue.status('EvSECOND6'), undefined);
} finally { await handle.stop(); }
const reopened = new SqliteQueue(process.argv[2]);
try {
  assert.equal(reopened.status('EvSECOND2'), 'done');
  assert.equal(reopened.followsThread(config.teamId, 'CSECONDTHREAD', '1791029813.000002'), true);
} finally { reopened.close(); }
console.log('alternate_installation_fresh_state_and_relay_passed');
