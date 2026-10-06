import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCredentials, BOT_SCOPES, USER_SCOPES } from '../src/config.ts';
import { StartupFailure, formatStartupFailure, startupFailure } from '../src/diagnostics.ts';
import { OperationTimeout } from '../src/lifecycle.ts';
import { SlackPrivateDmSink, SlackThreadReader, userReadPort } from '../src/slack.ts';
import { config } from './helpers.ts';

test('wrong or empty token input identifies its field without showing any entered value', () => {
  const valid = { appToken: 'xapp-public-synthetic', userToken: 'xoxp-public-synthetic', botToken: 'xoxb-public-synthetic' };
  for (const [field, phase] of [['appToken', 'app_token'], ['userToken', 'user_token'], ['botToken', 'bot_token']] as const) {
    for (const value of ['', 'synthetic-private-material', 'xoxe.synthetic-private-material']) {
      let failure: unknown;
      try { assertCredentials({ ...valid, [field]: value }); } catch (error) { failure = error; }
      assert.ok(failure instanceof StartupFailure); assert.equal(failure.phase, phase); assert.equal(failure.reason, 'format');
      assert.equal(formatStartupFailure(failure, 'runtime').includes('synthetic-private-material'), false);
    }
  }
});
test('unknown remote errors never become diagnostics; recognized codes and timeout map to fixed text', () => {
  const secret = 'synthetic-private-material-never-print';
  for (const error of [new Error(secret), secret, { code: secret, message: secret },
    { code: 'slack_webapi_platform_error', data: { error: secret, needed: secret, provided: secret }, message: secret }]) {
    const failure = startupFailure(error, 'user_auth'); assert.equal(failure.reason, 'unexpected');
    assert.equal(formatStartupFailure(error, 'user_auth').includes(secret), false);
  }
  assert.equal(startupFailure(new OperationTimeout(), 'socket').reason, 'timeout');
  for (const error of ['invalid_auth', 'token_revoked', 'token_expired', 'missing_scope'] as const) {
    const failure = startupFailure({ code: 'slack_webapi_platform_error', data: { error, access_token: secret } }, 'socket');
    assert.equal(failure.reason, error); assert.equal(formatStartupFailure(failure, 'runtime').includes(secret), false);
  }
});
test('permission diagnostics preserve strict identity and exact-scope rejection', async () => {
  for (const [identity, reason] of [
    [{ team_id: 'TOTHER', user_id: config.userId, scopes: [...USER_SCOPES] }, 'wrong_workspace'],
    [{ team_id: config.teamId, user_id: config.userId }, 'scope_metadata_missing'],
    [{ team_id: config.teamId, user_id: config.userId, scopes: ['channels:history'] }, 'scopes_mismatch']
  ] as const) {
    const reader = new SlackThreadReader({ async authTest() { return { team_id: identity.team_id, user_id: identity.user_id, scopes: 'scopes' in identity ? [...identity.scopes] : undefined }; }, async replies() { assert.fail(); } });
    await assert.rejects(reader.validateIdentity(USER_SCOPES), error => error instanceof StartupFailure && error.phase === 'user_auth' && error.reason === reason);
  }
  const sink = new SlackPrivateDmSink({ async authTest() { return { team_id: config.teamId, user_id: 'URADARBOT', bot_id: 'BTEST', scopes: [...BOT_SCOPES, 'chat:write.public'] }; },
    async openDm() { assert.fail(); }, async postDm() { assert.fail(); } }, true);
  await assert.rejects(sink.validateIdentity({ botUserId: 'URADARBOT', scopes: BOT_SCOPES }), error => error instanceof StartupFailure && error.phase === 'bot_auth' && error.reason === 'scopes_mismatch');
});
test('installed Web API SDK exposes auth scopes from response headers without live network access', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://slack.com/api/auth.test');
    assert.equal(options?.method, 'POST'); calls++;
    return new Response(JSON.stringify({ ok: true, team_id: config.teamId, user_id: config.userId }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-oauth-scopes': USER_SCOPES.join(',') } });
  };
  try {
    const reader = new SlackThreadReader(userReadPort('xoxp-public-synthetic'));
    await reader.validateIdentity(USER_SCOPES); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
test('implicit identify is recognized only on a user token; missing history and additional grants still fail closed', async () => {
  for (const scopes of [[...USER_SCOPES, 'identify'], ['identify'], [...USER_SCOPES, 'identify', 'search:read'], [...USER_SCOPES, 'identify', 'identity.basic']]) {
    const reader = new SlackThreadReader({ async authTest() { return { team_id: config.teamId, user_id: config.userId, scopes }; }, async replies() { assert.fail(); } });
    if (scopes.length === USER_SCOPES.length + 1) {
      await reader.validateIdentity(USER_SCOPES); assert.equal(reader.hasImplicitIdentify, true);
    } else {
      await assert.rejects(reader.validateIdentity(USER_SCOPES), error => error instanceof StartupFailure && error.reason === 'scopes_mismatch');
      assert.equal(reader.hasImplicitIdentify, false);
    }
  }
  const sink = new SlackPrivateDmSink({ async authTest() { return { team_id: config.teamId, user_id: 'URADARBOT', bot_id: 'BTEST', scopes: [...BOT_SCOPES, 'identify'] }; },
    async openDm() { assert.fail(); }, async postDm() { assert.fail(); } }, true);
  await assert.rejects(sink.validateIdentity({ botUserId: 'URADARBOT', scopes: BOT_SCOPES }), error => error instanceof StartupFailure && error.phase === 'bot_auth' && error.reason === 'scopes_mismatch');
});
