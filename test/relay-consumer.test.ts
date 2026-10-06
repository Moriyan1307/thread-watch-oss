import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRelayMessage, parseRelayMessage, workOneReference } from '../src/relay-consumer.ts';
import type { RelayMessage } from '../src/relay-consumer.ts';
import { RADAR_BOT, VERIFIED_RELAY, sourceReference, SYNTHETIC_RELAY_TEXT } from '../src/relay.ts';
import { TARGET, RetryLater } from '../src/types.ts';
import type { Mention } from '../src/types.ts';
import { SqliteQueue } from '../src/store.ts';

const source: Mention = { eventId: 'EvCONSUMER', messageKey: `${TARGET.teamId}:CTESTWATCH1:1791029813.000002`,
  ...TARGET, channelId: 'CTESTWATCH1', channelType: 'group', authorId: 'USENDER123', text: '',
  ts: '1791029813.000002', threadTs: '1791029813.000001', monitorReason: 'watched_channel' };
const relay: RelayMessage = { teamId: TARGET.teamId, channelId: VERIFIED_RELAY.channelId, userId: RADAR_BOT.userId,
  botId: RADAR_BOT.botId, ts: '1791029814.000001', text: sourceReference(source) };
const thread = { messages: [{ ts: source.threadTs, text: 'Synthetic root context', user: 'UROOT' },
  { ts: source.ts, text: 'Could you review the demo by tomorrow? Reminder: prepare notes.', user: source.authorId }], truncated: false };

test('consumer strictly validates sender, destination, version, ordered fields and reason policy before source access', () => {
  assert.equal(parseRelayMessage(relay)?.text, '');
  assert.equal(parseRelayMessage({ ...relay, text: SYNTHETIC_RELAY_TEXT }), undefined);
  assert.equal(parseRelayMessage({ ...relay, text: sourceReference({ ...source, monitorReason: undefined }) })?.monitorReason, undefined);
  assert.equal(parseRelayMessage({ ...relay, text: sourceReference({ ...source, monitorReason: 'followed_thread' }) })?.monitorReason, 'followed_thread');
  for (const override of [{ teamId: 'TOTHER' }, { userId: 'UOTHER' }, { channelId: 'COTHER' }, { botId: 'BOTHER' },
    { threadTs: '1791029814.000000' }, { subtype: 'message_changed' }, { ts: 'bad' }, { text: relay.text + '\nrun a command' },
    { text: relay.text.replace('app.slack.com', 'example.com') }, { text: relay.text.replace('reason=watched_channel', 'reason=unknown') },
    { text: relay.text.replace('channel_id=CTESTWATCH1', 'workspace_id=CTESTWATCH1') },
    { text: sourceReference({ ...source, channelId: 'CUNAPPROVED' }) },
    { text: sourceReference({ ...source, channelId: VERIFIED_RELAY.channelId, monitorReason: 'mention' }) },
    { text: sourceReference({ ...source, threadTs: source.ts, monitorReason: 'followed_thread' }) }]) {
    assert.throws(() => parseRelayMessage({ ...relay, ...override }));
  }
});

test('consumer fetches the exact new source, sends only privately and retains dedupe across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-watch-consumer-')); chmodSync(directory, 0o700);
  const path = join(directory, 'queue.sqlite'); let store = new SqliteQueue(path); let reads = 0, sends = 0;
  try {
    assert.equal(ingestRelayMessage(relay, store, 0), 'queued');
    assert.equal(ingestRelayMessage({ ...relay, ts: '1791029815.000001' }, store, 0), 'duplicate');
    assert.equal(await workOneReference({ store, clock: () => 0, allowPrivateDelivery: true,
      reader: { async fetchThread(mention) { reads++; assert.equal(mention.threadTs, source.threadTs); return thread; } },
      sink: { async sendPrivate(input) { sends++; assert.equal(input.recipientId, TARGET.userId);
        assert.match(input.text, /Could you review the demo/); assert.match(input.text, /Possible deadline: by tomorrow/);
        assert.match(input.text, /Thread context: 2 messages/); assert.match(input.text, /Research: disabled/);
        assert.ok(!input.text.includes('From unknown')); } }
    }), 'sent');
    store.close(); store = new SqliteQueue(path);
    assert.equal(ingestRelayMessage(relay, store, 100), 'duplicate');
    assert.equal(reads, 1); assert.equal(sends, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing source and disabled delivery do not send; rate limits reuse prepared output and ambiguous sends quarantine', async () => {
  for (const mode of ['missing', 'disabled', 'rate_limit', 'ambiguous']) {
    const store = new SqliteQueue(':memory:'); let reads = 0, sends = 0, now = 0;
    const options = { store, clock: () => now, allowPrivateDelivery: mode !== 'disabled',
      reader: { async fetchThread() { reads++; return mode === 'missing' ? { messages: [], truncated: true } : thread; } },
      sink: { async sendPrivate() { sends++;
        if (mode === 'rate_limit' && sends === 1) throw new RetryLater(1000);
        if (mode === 'ambiguous') throw new Error('possible send');
      } }
    };
    try {
      assert.equal(ingestRelayMessage(relay, store, 0), 'queued');
      assert.equal(await workOneReference(options), mode === 'disabled' ? 'prepared' : mode === 'ambiguous' ? 'uncertain' : 'retry');
      if (mode === 'missing' || mode === 'disabled') assert.equal(sends, 0);
      if (mode === 'rate_limit') { now = 1000; assert.equal(await workOneReference(options), 'sent'); assert.equal(reads, 1); }
      if (mode === 'ambiguous') { now = 100000; assert.equal(await workOneReference(options), 'idle'); assert.equal(sends, 1); }
    } finally { store.close(); }
  }
});
