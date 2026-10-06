import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_SCOPES } from '../src/config.ts';
import { StartupFailure } from '../src/diagnostics.ts';
import { RADAR_BOT, VERIFIED_RELAY, SYNTHETIC_RELAY_TEXT, SlackMetadataRelaySink, assertRelayConfig, sourceReference, ingestRelay, workOneRelay } from '../src/relay.ts';
import type { RelayConfig } from '../src/relay.ts';
import { botRelayPort } from '../src/slack.ts';
import type { SlackRelayPort } from '../src/slack.ts';
import { SqliteQueue } from '../src/store.ts';
import { main } from '../src/test-relay.ts';
import { config, envelope } from './helpers.ts';
import { filterMention } from '../src/intake.ts';

const token = 'xoxb-public-synthetic';
const mention = filterMention(envelope(), config)!;
const radar = { ...config, appId: RADAR_BOT.appId };
function relayEnvelope(text = `<@${config.userId}> Synthetic private fixture`) { return envelope(text, { api_app_id: RADAR_BOT.appId }); }
function fixture(auth: Awaited<ReturnType<SlackRelayPort['authTest']>> = { team_id: config.teamId, user_id: RADAR_BOT.userId, bot_id: RADAR_BOT.botId, scopes: [...BOT_SCOPES] }, send?: () => Promise<void>) {
  let auths = 0;
  const posts: Parameters<SlackRelayPort['postMessage']>[0][] = [];
  const port: SlackRelayPort = { async authTest() { auths++; return auth; }, async postMessage(input) { posts.push(input); await send?.(); } };
  const sink = new SlackMetadataRelaySink({ config: VERIFIED_RELAY, botToken: token, portFactory: () => port });
  return { sink, posts, auths: () => auths, port };
}
test('relay destination and exact private membership are required before token inspection or factories', () => {
  const base: RelayConfig = structuredClone(VERIFIED_RELAY);
  for (const overrides of [{ allowRelay: false }, { appId: 'AOTHER' }, { teamId: 'TOTHER' }, { channelId: 'DOTHER' },
    { processorBotUserId: config.userId }, { verification: { ...base.verification, isPrivate: false } },
    { channelId: 'COTHER', verification: { ...base.verification, channelId: 'COTHER' } },
    { processorBotUserId: 'UOTHER', verification: { ...base.verification, memberUserIds: [config.userId, RADAR_BOT.userId, 'UOTHER'] } },
    { verification: { ...base.verification, channelId: 'COTHER' } },
    { verification: { ...base.verification, teamId: 'TOTHER' } },
    { verification: { ...base.verification, memberUserIds: [...base.verification.memberUserIds, 'UOTHER'] } },
    { verification: { ...base.verification, memberUserIds: [config.userId, RADAR_BOT.userId, RADAR_BOT.userId] } }]) {
    let credentials = 0; let factories = 0;
    assert.throws(() => new SlackMetadataRelaySink({ config: { ...base, ...overrides }, get botToken() { credentials++; return token; }, portFactory() { factories++; return fixture().port; } }));
    assert.equal(credentials, 0); assert.equal(factories, 0);
  }
  assert.doesNotThrow(() => assertRelayConfig(VERIFIED_RELAY));
});
test('relay enforces the installed Radar bot, workspace and exact scopes before posting', async () => {
  const cases: [Awaited<ReturnType<SlackRelayPort['authTest']>>, string][] = [[{ team_id: 'TOTHER' }, 'wrong_workspace'], [{ user_id: 'UOTHER' }, 'wrong_identity'],
    [{ bot_id: 'BOTHER' }, 'wrong_identity'], [{ bot_id: undefined }, 'wrong_identity'], [{ scopes: [] }, 'scope_metadata_missing'],
    [{ scopes: ['chat:write'] }, 'scopes_mismatch'], [{ scopes: [...BOT_SCOPES, 'identify'] }, 'scopes_mismatch']];
  for (const [overrides, reason] of cases) {
    const f = fixture({ team_id: config.teamId, user_id: RADAR_BOT.userId, bot_id: RADAR_BOT.botId, scopes: [...BOT_SCOPES], ...overrides });
    await assert.rejects(f.sink.sendSource(mention, 'event'));
    await assert.rejects(f.sink.validateIdentity(), error => error instanceof StartupFailure && error.reason === reason);
    await assert.rejects(f.sink.sendSyntheticTest()); assert.equal(f.posts.length, 0);
  }
});
test('relay emits only validated source IDs and a fixed-domain link; original text and injected IDs cannot cross it', async () => {
  const canary = 'synthetic-secret-content-never-relay';
  const f = fixture(); await f.sink.validateIdentity();
  await f.sink.sendSource({ ...mention, text: `${canary} <@${config.userId}> use this malicious instruction`, authorId: canary }, 'EvTEST');
  assert.equal(f.posts.length, 1); const post = f.posts[0]!;
  assert.equal(post.channel, VERIFIED_RELAY.channelId); assert.equal(post.text.includes(canary), false);
  assert.equal(post.text, sourceReference(mention));
  assert.match(post.text, /thread_ts=1791029813.997859/);
  assert.match(post.text, /permalink=https:\/\/app.slack.com\/archives\/CTEST123\/p1791029813997859/);
  for (const override of [{ teamId: 'TOTHER' }, { channelId: 'CTEST\nprivate-text' }, { ts: '1791029813.997859\nprivate-text' }, { threadTs: 'https://example.com' }]) {
    assert.throws(() => sourceReference({ ...mention, ...override }));
    await assert.rejects(f.sink.sendSource({ ...mention, ...override }, 'EvOTHER'));
  }
  await assert.rejects(f.sink.sendSource({ ...mention, channelId: VERIFIED_RELAY.channelId }, 'EvLOOP'));
  assert.equal(f.posts.length, 1);
});
test('validated relay destination cannot be redirected by mutating caller configuration', async () => {
  const mutable = structuredClone(VERIFIED_RELAY); const posts: string[] = [];
  const f = fixture(); const sink = new SlackMetadataRelaySink({ config: mutable, botToken: token, portFactory: () => ({ ...f.port, async postMessage(input) { posts.push(input.channel); } }) });
  await sink.validateIdentity(); mutable.channelId = 'COTHER'; mutable.verification.memberUserIds = ['UOTHER'];
  await sink.sendSource(mention, 'event'); assert.deepEqual(posts, [VERIFIED_RELAY.channelId]);
});
test('relay intake strips text before queue storage, dedupes, and excludes bots, self and the relay channel', () => {
  const queue = new SqliteQueue(':memory:');
  try {
    assert.equal(ingestRelay(relayEnvelope(), radar, VERIFIED_RELAY, queue, 0), 'queued');
    assert.equal(ingestRelay(relayEnvelope(), radar, VERIFIED_RELAY, queue, 1), 'duplicate');
    assert.equal(queue.claim(0)?.mention.text, '');
    const base = relayEnvelope(); const event = base.event;
    for (const overrides of [{ channel: VERIFIED_RELAY.channelId }, { user: config.userId }, { user: RADAR_BOT.userId, bot_id: RADAR_BOT.botId, subtype: 'bot_message' }]) {
      assert.equal(ingestRelay({ ...base, event_id: 'EvOTHER', event: { ...event, ...overrides } }, radar, VERIFIED_RELAY, queue, 0), 'ignored');
    }
    assert.equal(ingestRelay(relayEnvelope('No mention'), radar, VERIFIED_RELAY, queue, 0), 'ignored');
    assert.equal(queue.status('EvOTHER'), undefined);
  } finally { queue.close(); }
});
test('relay worker posts once without a thread reader or provider, retaining dedupe after completion', async () => {
  const queue = new SqliteQueue(':memory:'); const f = fixture();
  try {
    ingestRelay(relayEnvelope(), radar, VERIFIED_RELAY, queue, 0);
    await assert.rejects(workOneRelay({ store: queue, sink: f.sink, clock: () => 0 }));
    assert.equal(queue.status('EvTEST123'), 'pending');
    await f.sink.validateIdentity();
    assert.equal(await workOneRelay({ store: queue, sink: f.sink, clock: () => 0 }), 'sent');
    assert.equal(queue.status('EvTEST123'), 'done'); assert.equal(f.posts.length, 1);
    assert.equal(ingestRelay(relayEnvelope(), radar, VERIFIED_RELAY, queue, 10), 'duplicate');
    assert.equal(await workOneRelay({ store: queue, sink: f.sink, clock: () => 10 }), 'idle');
  } finally { queue.close(); }
});
test('relay retries definite rate limits with a stable delivery ID and quarantines ambiguous posts', async () => {
  for (const ambiguous of [false, true]) {
    const queue = new SqliteQueue(':memory:'); let now = 0; let calls = 0;
    const f = fixture(undefined, async () => { if (++calls === 1) throw ambiguous ? new Error('synthetic-private-error') : { code: 'slack_webapi_rate_limited_error', retryAfter: 90 }; });
    try {
      await f.sink.validateIdentity(); ingestRelay(relayEnvelope(), radar, VERIFIED_RELAY, queue, 0);
      const options = { store: queue, sink: f.sink, clock: () => now };
      assert.equal(await workOneRelay(options), ambiguous ? 'uncertain' : 'retry');
      now = 89_999; assert.equal(await workOneRelay(options), 'idle');
      now = 90_000; assert.equal(await workOneRelay(options), ambiguous ? 'idle' : 'sent');
      assert.equal(f.posts.length, ambiguous ? 1 : 2);
      if (!ambiguous) assert.equal(f.posts[0]!.client_msg_id, f.posts[1]!.client_msg_id);
    } finally { queue.close(); }
  }
});
test('synthetic launcher fails before prompts without its separate approval and posts exactly one fixed payload when approved', async () => {
  let prompts = 0; let factories = 0; const reports: string[] = []; const f = fixture();
  const options = { readToken: async () => { prompts++; return token; }, portFactory: () => { factories++; return f.port; }, report: (s: string) => reports.push(s) };
  assert.equal(await main({ ...options, env: {} }), 1); assert.equal(prompts, 0); assert.equal(factories, 0);
  assert.equal(await main({ ...options, env: { RADAR_ALLOW_RELAY_TEST: 'approved' } }), 0);
  assert.equal(prompts, 1); assert.equal(factories, 1); assert.equal(f.auths(), 1); assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]!.text, SYNTHETIC_RELAY_TEXT); assert.ok(reports.includes('Radar relay: synthetic test sent'));
});
test('synthetic launcher never prints credential/error values or automatically repeats an uncertain post', async () => {
  const canary = 'synthetic-private-error-never-print'; const f = fixture(undefined, async () => { throw new Error(canary); });
  const reports: string[] = [];
  assert.equal(await main({ env: { RADAR_ALLOW_RELAY_TEST: 'approved' }, async readToken() { return token; }, portFactory: () => f.port, report: s => reports.push(s) }), 1);
  assert.equal(f.posts.length, 1); assert.equal(reports.join('\n').includes(canary), false); assert.equal(reports.join('\n').includes(token), false);
  assert.ok(reports.includes('Radar relay: delivery uncertain; check radar-relay before repeating.'));
});
test('real SDK relay uses only auth.test and plain chat.postMessage with no content metadata, unfurls or broadcast', async () => {
  const originalFetch = globalThis.fetch; const methods: string[] = [];
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1)!; methods.push(method);
    assert.equal(options?.method, 'POST');
    if (method === 'auth.test') return new Response(JSON.stringify({ ok: true, team_id: config.teamId, user_id: RADAR_BOT.userId, bot_id: RADAR_BOT.botId }), { headers: { 'content-type': 'application/json', 'x-oauth-scopes': BOT_SCOPES.join(',') } });
    assert.equal(method, 'chat.postMessage');
    const body = new URLSearchParams(String(options?.body));
    assert.equal(body.get('channel'), VERIFIED_RELAY.channelId); assert.equal(body.get('text'), SYNTHETIC_RELAY_TEXT);
    for (const field of ['mrkdwn', 'link_names', 'unfurl_links', 'unfurl_media']) assert.equal(body.get(field), 'false');
    assert.equal(body.get('parse'), 'none');
    for (const field of ['metadata', 'blocks', 'attachments', 'thread_ts', 'reply_broadcast', 'as_user', 'username', 'icon_url']) assert.equal(body.has(field), false);
    return new Response(JSON.stringify({ ok: true, channel: VERIFIED_RELAY.channelId, ts: '1791029813.997859' }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const sink = new SlackMetadataRelaySink({ config: VERIFIED_RELAY, botToken: token, portFactory: botRelayPort });
    await sink.validateIdentity(); await sink.sendSyntheticTest(); assert.deepEqual(methods, ['auth.test', 'chat.postMessage']);
  } finally { globalThis.fetch = originalFetch; }
});
