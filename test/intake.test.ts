import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMention, hasExactMention, ingest } from '../src/intake.ts';
import { SqliteQueue } from '../src/store.ts';
import { config, envelope } from './helpers.ts';

test('exact Slack mention markup only; ignores names, display labels, other users and groups', () => {
  for (const text of ['@the configured user', 'UTEST00001', '<@UTEST000010>', '<@UTEST00001|the configured user>', '&lt;@UTEST00001&gt;', '<!channel>', '<!subteam^S123>']) assert.equal(hasExactMention(text, config.userId), false, text);
  assert.equal(hasExactMention(`Hi <@${config.userId}>, thanks`, config.userId), true);
});
test('workspace, app and installer identity are enforced independently of message author', () => {
  assert.equal(filterMention(envelope(), config)?.authorId, 'USENDER123');
  for (const overrides of [
    { team_id: 'TOTHER' }, { api_app_id: 'AOTHER' }, { authorizations: undefined },
    { authorizations: [{ team_id: config.teamId, user_id: 'UOTHER', is_bot: false }] },
    { authorizations: [{ team_id: config.teamId, user_id: config.userId, is_bot: true }] },
    { authorizations: [{ team_id: 'TOTHER', user_id: config.userId, is_bot: false }] },
    { authorizations: [envelope().authorizations[0], { user_id: 'UOTHER' }] }
  ]) assert.equal(filterMention(envelope(undefined, overrides), config), undefined);
});
test('all four channel types are handled; thread root selected correctly', () => {
  for (const channel_type of config.channelTypes) {
    const body = envelope();
    Object.assign(body.event, { channel_type, thread_ts: '1791029000.000001' });
    assert.equal(filterMention(body, config)?.threadTs, '1791029000.000001');
  }
});
test('ignores deletion, replies metadata, bots, self, malformed timestamps and unsupported channels', () => {
  for (const changed of [{ subtype: 'message_deleted' }, { subtype: 'message_replied' }, { bot_id: 'BTEST' }, { user: config.userId }, { ts: 'bad' }, { channel_type: 'unknown' }, { thread_ts: 'bad' }]) {
    const body = envelope(); Object.assign(body.event, changed);
    assert.equal(filterMention(body, config), undefined);
  }
});
test('a newly added mention in an edit matches once; edits of an existing mention are ignored', () => {
  const base = envelope();
  const event = { type: 'message', subtype: 'message_changed', channel: base.event.channel, channel_type: 'channel', message: base.event, previous_message: { text: 'Initial unmentioned message' } };
  assert.ok(filterMention(envelope(undefined, { event }), config));
  event.previous_message.text = base.event.text;
  assert.equal(filterMention(envelope(undefined, { event }), config), undefined);
});
test('queue dedupes event retry and a second event for the same message; ignored messages are not stored', () => {
  const store = new SqliteQueue(':memory:');
  try {
    assert.equal(ingest(envelope('Unrelated'), config, store, 0), 'ignored');
    assert.equal(store.claim(0), undefined);
    assert.equal(ingest(envelope(), config, store, 0), 'queued');
    assert.equal(ingest(envelope(), config, store, 0), 'duplicate');
    assert.equal(ingest(envelope(undefined, { event_id: 'EvOTHER123' }), config, store, 0), 'duplicate');
  } finally { store.close(); }
});
test('invalid or unconfirmed target config fails closed', () => {
  assert.throws(() => filterMention(envelope(), { ...config, appId: '' }));
  assert.throws(() => filterMention(envelope(), { ...config, userId: 'UOTHER' }));
});
