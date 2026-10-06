import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { hostedDirectories } from '../src/mac-storage.ts';
import { credentialsFromPipe, main } from '../src/start-mac.ts';
import { loadHostedConfig, assertHostedConfig } from '../src/hosted.ts';
import { TARGET } from '../src/types.ts';
import { RADAR_BOT, VERIFIED_RELAY } from '../src/relay.ts';

const env = { RADAR_TEAM_ID: TARGET.teamId, RADAR_USER_ID: TARGET.userId,
  RADAR_APP_ID: RADAR_BOT.appId, RADAR_CONFIRMED_SEPARATE_APP_ID: RADAR_BOT.appId,
  RADAR_BOT_USER_ID: RADAR_BOT.userId, RADAR_VERIFIED_APP_SCOPES: 'connections:write',
  RADAR_ALLOW_SLACK_CONNECTION: 'approved', RADAR_ALLOW_SLACK_READS: 'approved',
  RADAR_ALLOW_PRIVATE_RELAY: 'approved', RADAR_RELAY_CHANNEL_ID: VERIFIED_RELAY.channelId,
  RADAR_ALLOW_CONTINUOUS: 'approved', RADAR_DEPLOYMENT_APPROVED: 'approved',
  RADAR_DATA_DIRECTORY: hostedDirectories('darwin').data,
  RADAR_WATCH_CHANNEL_IDS: 'CTESTWATCH1', RADAR_ALLOW_CHANNEL_MONITORING: 'approved', RADAR_FOLLOW_MENTION_THREADS: 'approved' };
const tokens = { SLACK_APP_TOKEN: 'xapp-public-fixture', SLACK_USER_TOKEN: 'xoxp-public-fixture', SLACK_BOT_TOKEN: 'xoxb-public-fixture' };

test('Mac paths use the OS user home and Linux config retains its fixed path and gates', () => {
  assert.equal(hostedDirectories('darwin').data, join(userInfo().homedir, 'Library/Application Support/thread-watch/data'));
  assert.deepEqual(hostedDirectories('linux'), { data: '/var/lib/thread-watch', run: '/run/thread-watch' });
  const config = loadHostedConfig(env, 'darwin'); assert.equal(config.hostingPlatform, 'darwin');
  for (const override of [{ dataDirectory: '/tmp/untrusted' }, { deploymentApproved: false }, { continuousApproved: false },
    { botUserId: TARGET.userId }, { hostingPlatform: 'linux' as const }]) {
    assert.throws(() => assertHostedConfig({ ...config, ...override }));
  }
  assert.throws(() => loadHostedConfig(env));
});
test('credential pipe rejects oversized, extra, nonstring, missing and malformed fields', () => {
  assert.deepEqual(credentialsFromPipe(JSON.stringify(tokens)), { appToken: tokens.SLACK_APP_TOKEN, userToken: tokens.SLACK_USER_TOKEN, botToken: tokens.SLACK_BOT_TOKEN });
  for (const value of [{ ...tokens, EXTRA: 'public' }, { ...tokens, SLACK_BOT_TOKEN: 1 },
    { ...tokens, SLACK_APP_TOKEN: 'wrong' }, {}, null, [], { ...tokens, SLACK_APP_TOKEN: 'xapp-' + 'a'.repeat(20000) }]) {
    assert.throws(() => credentialsFromPipe(JSON.stringify(value)));
  }
});
test('Mac preflight and rejected activation never read credentials or start sockets', { skip: process.platform !== 'darwin' }, async () => {
  let reads = 0; let starts = 0;
  const options = { readCredentials() { reads++; assert.fail(); }, start: async () => { starts++; assert.fail(); }, report() {} };
  assert.equal(await main({ ...options, env, preflight: true }), 0);
  assert.equal(await main({ ...options, env }), 78);
  assert.equal(await main({ ...options, env: { ...env, RADAR_DATA_DIRECTORY: '/tmp/untrusted' }, preflight: true }), 78);
  assert.equal(reads, 0); assert.equal(starts, 0);
});
test('activated Mac entry preserves hosted policy and emits only fixed status diagnostics', { skip: process.platform !== 'darwin' }, async () => {
  const reports: string[] = []; const statuses: string[] = [];
  const code = await main({ env: { ...env, RADAR_MAC_ACTIVATION_APPROVED: 'approved' },
    readCredentials: () => credentialsFromPipe(JSON.stringify(tokens)),
    start: async options => {
      assert.equal(options.config.hostingPlatform, 'darwin');
      assert.deepEqual(options.config.monitoring.watchChannelIds, ['CTESTWATCH1']);
      assert.equal(options.config.monitoring.followMentionThreads, true);
      options.onStatus?.('started');
      return { done: Promise.resolve(), async stop() {} };
    }, report: s => reports.push(s), record: s => statuses.push(s) });
  assert.equal(code, 0); assert.deepEqual(statuses, ['started']);
  assert.deepEqual(reports, ['Thread Watch macOS: started']);
  const failure = await main({ env: { ...env, RADAR_MAC_ACTIVATION_APPROVED: 'approved' },
    readCredentials() { throw new Error('PRIVATE_ERROR_FIXTURE'); }, report: s => reports.push(s) });
  assert.equal(failure, 78); assert.ok(reports.every(s => !s.includes('PRIVATE_ERROR_FIXTURE') && !s.includes('xapp')));
});
