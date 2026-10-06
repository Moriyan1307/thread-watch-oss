// Fully offline: actual queue/routing/consumer/Slack adapters, synthetic ports.
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TARGET } from '../src/types.ts';
import { USER_SCOPES, BOT_SCOPES } from '../src/config.ts';
import { loadHostedConfig } from '../src/hosted.ts';
import { ingestMonitoredRelay } from '../src/monitoring.ts';
import { SqliteQueue } from '../src/store.ts';
import { RADAR_BOT, VERIFIED_RELAY, SlackMetadataRelaySink, workOneRelay } from '../src/relay.ts';
import { ingestRelayMessage, workOneReference } from '../src/relay-consumer.ts';
import { SlackThreadReader, SlackPrivateDmSink } from '../src/slack.ts';

const directory = mkdtempSync(join(tmpdir(), 'thread-watch-demo-')); chmodSync(directory, 0o700);
const producerPath = join(directory, 'producer.sqlite'), consumerPath = join(directory, 'consumer.sqlite');
let producer = new SqliteQueue(producerPath), consumer = new SqliteQueue(consumerPath);
const config = loadHostedConfig({ ...process.env, RADAR_DATA_DIRECTORY: '/var/lib/thread-watch' });
const events = [
  { channel: 'CTESTWATCH1', ts: '1791029813.000001', text: 'Demo update: the new build is ready.', user: TARGET.userId },
  { channel: 'CTESTTHREAD', ts: '1791029813.000002', text: `<@${TARGET.userId}> Could you review the demo by tomorrow?`, user: 'USYNTHETIC123' },
  { channel: 'CTESTTHREAD', ts: '1791029813.000003', thread_ts: '1791029813.000002', text: 'Reminder: prepare the notes before the review.', user: 'USYNTHETIC123' }
];
let relays = 0, summaries = 0, reads = 0;
const references = [];
const relaySink = new SlackMetadataRelaySink({ config: config.relay, botToken: 'xoxb-public-fixture',
  portFactory() { return {
    async authTest() { return { team_id: TARGET.teamId, user_id: RADAR_BOT.userId, bot_id: RADAR_BOT.botId, scopes: [...BOT_SCOPES] }; },
    async postMessage(input) {
      assert.equal(input.channel, VERIFIED_RELAY.channelId);
      assert.ok(!input.text.includes('Demo update:'));
      const message = { teamId: TARGET.teamId, channelId: input.channel, userId: RADAR_BOT.userId,
        botId: RADAR_BOT.botId, ts: '1791029814.' + String(++relays).padStart(6, '0'), text: input.text };
      references.push(message); assert.equal(ingestRelayMessage(message, consumer), 'queued');
      console.log('Relay:', input.text.split('\n').at(-1), '(IDs only)');
    }
  }; }
});
const reader = new SlackThreadReader({
  async authTest() { return { team_id: TARGET.teamId, user_id: TARGET.userId, scopes: [...USER_SCOPES] }; },
  async replies({ channel, ts }) { reads++; return { messages: events.filter(e => e.channel === channel && (e.thread_ts ?? e.ts) === ts) }; }
});
const sink = new SlackPrivateDmSink({
  async authTest() { return { team_id: TARGET.teamId, user_id: VERIFIED_RELAY.processorBotUserId, bot_id: 'BTESTPROC', scopes: [...BOT_SCOPES] }; },
  async openDm(userId) { assert.equal(userId, TARGET.userId); return 'DTESTPRIVATE'; },
  async postDm(input) { summaries++; assert.equal(input.channel, 'DTESTPRIVATE');
    assert.ok(!input.text.includes('From unknown'));
    console.log('Private summary:', input.text.split('\n').find(line => line.startsWith('From '))); }
}, true);
function envelope(event, index) { return { type: 'event_callback', team_id: TARGET.teamId, api_app_id: config.appId,
  event_id: 'EvDEMO' + index, authorizations: [{ team_id: TARGET.teamId, user_id: TARGET.userId, is_bot: false }],
  event: { type: 'message', channel_type: 'channel', ...event } }; }
try {
  await relaySink.validateIdentity(); await reader.validateIdentity(USER_SCOPES);
  await sink.validateIdentity({ botUserId: VERIFIED_RELAY.processorBotUserId, scopes: BOT_SCOPES });
  for (const [index, event] of events.entries()) {
    if (index === 2) { producer.close(); producer = new SqliteQueue(producerPath); console.log('Watcher restarted: followed-thread state preserved.'); }
    assert.equal(ingestMonitoredRelay(envelope(event, index), config, config.relay, config.monitoring, producer, Date.now()), 'queued');
    assert.equal(await workOneRelay({ store: producer, sink: relaySink }), 'sent');
    assert.equal(await workOneReference({ store: consumer, reader, sink, allowPrivateDelivery: true }), 'sent');
  }
  consumer.close(); consumer = new SqliteQueue(consumerPath);
  assert.equal(ingestRelayMessage(references[0], consumer), 'duplicate');
  assert.equal(ingestMonitoredRelay(envelope(events[0], 0), config, config.relay, config.monitoring, producer, Date.now()), 'duplicate');
  assert.deepEqual([relays, summaries, reads], [3, 3, 3]);
  console.log('PASS: 3 sources → 3 metadata relays → 3 private summaries; both queues deduplicate after restart.');
  console.log('Synthetic/offline only. Local rules; no Slack connection, AI provider, or reminders created.');
} finally { producer.close(); consumer.close(); rmSync(directory, { recursive: true, force: true }); }
