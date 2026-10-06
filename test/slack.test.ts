import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlackPrivateDmSink, SlackThreadReader } from '../src/slack.ts';
import { filterMention } from '../src/intake.ts';
import { RetryLater } from '../src/types.ts';
import { config, envelope } from './helpers.ts';

const mention = filterMention(envelope(), config)!;
test('read adapter validates the target user and workspace before fetching any thread', async () => {
  let reads = 0;
  const reader = new SlackThreadReader({
    async authTest() { return { team_id: config.teamId, user_id: config.userId }; },
    async replies() { reads++; return {}; }
  });
  await assert.rejects(reader.fetchThread(mention)); assert.equal(reads, 0);
  await reader.validateIdentity(); await reader.fetchThread(mention); assert.equal(reads, 1);
  for (const identity of [{ team_id: 'TOTHER', user_id: config.userId }, { team_id: config.teamId, user_id: 'UOTHER' }, { team_id: config.teamId, user_id: config.userId, bot_id: 'BTEST' }]) {
    const invalid = new SlackThreadReader({ async authTest() { return identity; }, async replies() { assert.fail(); } });
    await assert.rejects(invalid.validateIdentity());
  }
});
test('thread adapter follows cursors, uses the root timestamp, and declares truncation at its bound', async () => {
  let calls = 0;
  const threaded = { ...mention, threadTs: '1791029000.000001' };
  const reader = new SlackThreadReader({
    async authTest() { return { team_id: config.teamId, user_id: config.userId }; },
    async replies(args) {
      assert.equal(args.channel, mention.channelId); assert.equal(args.ts, threaded.threadTs); assert.equal(args.limit, 15);
      if (calls) assert.equal(args.cursor, `cursor${calls}`);
      calls++;
      return { messages: Array.from({length:15}, (_,i) => ({text:'Synthetic context', ts:`1791029000.${String(i).padStart(6,'0')}`})), response_metadata: { next_cursor: `cursor${calls}` } };
    }
  });
  await reader.validateIdentity();
  const context = await reader.fetchThread(threaded);
  assert.equal(calls, 3); assert.equal(context.messages.length, 45); assert.equal(context.truncated, true);
});
test('Slack 429 is converted to a deferred retry using Retry-After', async () => {
  const reader = new SlackThreadReader({
    async authTest() { return { team_id: config.teamId, user_id: config.userId }; },
    async replies(): Promise<never> { throw { code:'slack_webapi_rate_limited_error', retryAfter:90 }; }
  });
  await reader.validateIdentity();
  await assert.rejects(reader.fetchThread(mention), error => error instanceof RetryLater && error.delayMs === 90_000);
});
test('DM sink defaults to disabled and refuses arbitrary recipients or non-DM channels', async () => {
  let opens = 0; let sends = 0;
  const port = {
    async authTest() { return { team_id: config.teamId, bot_id:'BTEST123' }; },
    async openDm(userId: string) { assert.equal(userId, config.userId); opens++; return 'DTEST123'; },
    async postDm() { sends++; }
  };
  const disabled = new SlackPrivateDmSink(port);
  await assert.rejects(disabled.validateIdentity());
  await assert.rejects(disabled.sendPrivate({ recipientId:config.userId, text:'Synthetic', idempotencyKey:'EvTEST' }));
  assert.equal(opens,0);
  const sink = new SlackPrivateDmSink(port, true); await sink.validateIdentity();
  await assert.rejects(sink.sendPrivate({ recipientId:'UOTHER', text:'Synthetic', idempotencyKey:'EvTEST' }));
  assert.equal(opens,0);
  await sink.sendPrivate({ recipientId:config.userId, text:'Synthetic', idempotencyKey:'EvTEST' });
  assert.equal(sends,1);
  const bad = new SlackPrivateDmSink({ ...port, async openDm() { return 'CCHANNEL123'; } }, true);
  await bad.validateIdentity();
  await assert.rejects(bad.sendPrivate({ recipientId:config.userId, text:'Synthetic', idempotencyKey:'EvTEST' }));
  assert.equal(sends,1);
});
