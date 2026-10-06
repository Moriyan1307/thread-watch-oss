import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { APPROVED_WATCH_CHANNELS, assertMonitoringPolicy, ingestMonitoredRelay, loadMonitoringPolicy } from '../src/monitoring.ts';
import { RADAR_BOT, VERIFIED_RELAY, sourceReference } from '../src/relay.ts';
import { SqliteQueue } from '../src/store.ts';
import { config, envelope } from './helpers.ts';

const radar = { ...config, appId: RADAR_BOT.appId };
const eng = APPROVED_WATCH_CHANNELS[0]!.id;
const policy = { watchChannelIds: [eng], channelMonitoringApproved: true, followMentionThreads: true };
const root = '1791029813.000001';
function message(index: number, event: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  const base = envelope('Synthetic fixture', { api_app_id: RADAR_BOT.appId, event_id: `EvMONITOR${index}` });
  return { ...base, ...body, event: { ...base.event, ts: `1791029813.${String(index).padStart(6, '0')}`, ...event } };
}
test('all watched-channel new messages need no mention, including owner, ordinary bots and textless file messages; other channels remain mention-only', () => {
  const store = new SqliteQueue(':memory:');
  try {
    for (const [index, event] of [[1, {}], [2, { user: config.userId }], [3, { user: undefined, subtype: 'bot_message', bot_id: 'BOTHER' }], [4, { subtype: 'file_share', text: undefined }]] as const) {
      assert.equal(ingestMonitoredRelay(message(index, { channel: eng, channel_type: 'group', ...event }), radar, VERIFIED_RELAY, policy, store, 0), 'queued');
      const job = store.claim(0)!;
      assert.equal(job.mention.text, ''); assert.equal(job.mention.monitorReason, 'watched_channel');
      store.complete(job.id, 0);
    }
    assert.equal(ingestMonitoredRelay(message(5), radar, VERIFIED_RELAY, policy, store, 0), 'ignored');
    assert.equal(ingestMonitoredRelay(message(6, { text: `<@${config.userId}> question` }), radar, VERIFIED_RELAY, policy, store, 0), 'queued');
    assert.equal(store.claim(0)!.mention.monitorReason, 'mention');
  } finally { store.close(); }
});
test('root or reply mention starts following the entire thread; later nonmention owner/bot replies count, unrelated threads do not', () => {
  for (const mentionInReply of [false, true]) {
    const store = new SqliteQueue(':memory:');
    try {
      assert.equal(ingestMonitoredRelay(message(1, { text: `<@${config.userId}> review`, ...(mentionInReply ? { thread_ts: '1791029000.000001' } : {}) }), radar, VERIFIED_RELAY, policy, store, 0), 'queued');
      const threadTs = mentionInReply ? '1791029000.000001' : root;
      assert.equal(store.followsThread(config.teamId, 'CTEST123', threadTs), true);
      for (const [index, author] of [[2, {}], [3, { user: config.userId }], [4, { subtype: 'bot_message', bot_id: 'BOTHER', user: undefined }]] as const) {
        assert.equal(ingestMonitoredRelay(message(index, { thread_ts: threadTs, ...author }), radar, VERIFIED_RELAY, policy, store, 0), 'queued');
      }
      assert.equal(ingestMonitoredRelay(message(5, { thread_ts: '1791028000.000001' }), radar, VERIFIED_RELAY, policy, store, 0), 'ignored');
      assert.equal(ingestMonitoredRelay(message(6, { channel: 'COTHER', thread_ts: threadTs }), radar, VERIFIED_RELAY, policy, store, 0), 'ignored');
    } finally { store.close(); }
  }
});
test('thread tracking survives job expiry and restart, persists references only and dedupes overlapping channel/mention/broadcast rules', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-monitor-')); const path = join(directory, 'queue.sqlite');
  let store = new SqliteQueue(path);
  try {
    const body = message(1, { channel: eng, channel_type: 'group', text: `<@${config.userId}> PRIVATE_FIXTURE_NEVER_STORE` });
    assert.equal(ingestMonitoredRelay(body, radar, VERIFIED_RELAY, policy, store, 0), 'queued');
    assert.equal(ingestMonitoredRelay(body, radar, VERIFIED_RELAY, policy, store, 0), 'duplicate');
    assert.equal(ingestMonitoredRelay({ ...body, event_id: 'EvBROADCAST', event: { ...body.event, subtype: 'thread_broadcast', thread_ts: root } }, radar, VERIFIED_RELAY, policy, store, 0), 'duplicate');
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(JSON.stringify(db.prepare('SELECT * FROM jobs').all()).includes('PRIVATE_FIXTURE_NEVER_STORE'), false); }
    finally { db.close(); }
    store.expire(30 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
    store.close(); store = new SqliteQueue(path);
    assert.equal(store.followsThread(config.teamId, eng, root), true);
    const followOnly = { ...policy, watchChannelIds: [] };
    assert.equal(ingestMonitoredRelay(message(2, { channel: eng, channel_type: 'group', thread_ts: root }), radar, VERIFIED_RELAY, followOnly, store, 0), 'queued');
    assert.equal(store.claim(0)!.mention.monitorReason, 'followed_thread');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('mention in a newly edited message seeds follow state even if its watched-channel source job was already delivered', () => {
  const store = new SqliteQueue(':memory:');
  try {
    const body = message(1, { channel: eng, channel_type: 'group' });
    ingestMonitoredRelay(body, radar, VERIFIED_RELAY, policy, store, 0);
    const job = store.claim(0)!; store.complete(job.id, 0);
    const edit = { type: 'message', subtype: 'message_changed', channel: eng, channel_type: 'group',
      message: { ...body.event, text: `<@${config.userId}> edited fixture` }, previous_message: { text: 'Initial fixture' } };
    assert.equal(ingestMonitoredRelay(message(2, edit), radar, VERIFIED_RELAY, policy, store, 0), 'duplicate');
    assert.equal(store.followsThread(config.teamId, eng, root), true);
  } finally { store.close(); }
});
test('durable enqueue failure rolls back new tracking so the failed event is never acknowledged as saved', () => {
  class FailedQueue extends SqliteQueue { override enqueue(): boolean { throw new Error('public fixture write failure'); } }
  const store = new FailedQueue(':memory:');
  try {
    assert.throws(() => ingestMonitoredRelay(message(1, { text: `<@${config.userId}> fixture` }), radar, VERIFIED_RELAY, policy, store, 0));
    assert.equal(store.followsThread(config.teamId, 'CTEST123', root), false);
  } finally { store.close(); }
});
test('expanded intake retains workspace/app/installer/relay/automation-loop guards and ignores system/reply metadata events', () => {
  const store = new SqliteQueue(':memory:');
  try {
    for (const event of [{ channel: VERIFIED_RELAY.channelId }, { user: RADAR_BOT.userId }, { user: 'UOTHER', bot_id: RADAR_BOT.botId },
      { user: VERIFIED_RELAY.processorBotUserId }, { subtype: 'message_replied' }, { subtype: 'message_deleted' }, { subtype: 'channel_join' }, { ts: 'bad' }, { bot_id: 'BOTHER\nBAD' }]) {
      assert.equal(ingestMonitoredRelay(message(1, { channel: eng, channel_type: 'group', ...event }), radar, VERIFIED_RELAY, policy, store, 0), 'ignored');
    }
    for (const body of [{ team_id: 'TOTHER' }, { api_app_id: 'AOTHER' }, { authorizations: [{ team_id: config.teamId, user_id: 'UOTHER', is_bot: false }] }]) {
      assert.equal(ingestMonitoredRelay(message(1, { channel: eng }, body), radar, VERIFIED_RELAY, policy, store, 0), 'ignored');
    }
    assert.equal(store.claim(0), undefined);
  } finally { store.close(); }
});
test('broader policies require exact approved channel IDs/gates; v2 relay reasons are fixed enums without message text', () => {
  for (const invalid of [{ ...policy, watchChannelIds: ['COTHER'] }, { ...policy, channelMonitoringApproved: false }, { ...policy, watchChannelIds: [eng, eng] }]) assert.throws(() => assertMonitoringPolicy(invalid));
  assert.throws(() => loadMonitoringPolicy({ RADAR_FOLLOW_MENTION_THREADS: 'true' }));
  const store = new SqliteQueue(':memory:');
  try {
    ingestMonitoredRelay(message(1, { channel: eng, text: 'PRIVATE_FIXTURE' }), radar, VERIFIED_RELAY, policy, store, 0);
    const source = store.claim(0)!.mention;
    const payload = sourceReference(source);
    assert.ok(payload.startsWith('Radar source v2\n')); assert.ok(payload.endsWith('reason=watched_channel'));
    assert.equal(payload.includes('PRIVATE_FIXTURE'), false);
    assert.throws(() => sourceReference({ ...source, monitorReason: 'watched_channel\ncontent=injection' as never }));
  } finally { store.close(); }
});
