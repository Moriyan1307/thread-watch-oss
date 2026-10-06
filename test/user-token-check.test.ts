import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUserToken } from '../src/check-user-token.ts';
import { USER_SCOPES } from '../src/config.ts';
import { ScopeMismatchFailure, formatStartupFailure } from '../src/diagnostics.ts';
import { TARGET } from '../src/types.ts';

const env = { RADAR_APP_ID: 'ATEST00001', RADAR_CONFIRMED_SEPARATE_APP_ID: 'ATEST00001',
  RADAR_TEAM_ID: TARGET.teamId, RADAR_USER_ID: TARGET.userId,
  RADAR_ALLOW_SLACK_CONNECTION: 'approved', RADAR_ALLOW_SLACK_READS: 'approved' };
test('user-only check requires fixed approved app/workspace/user before prompting or authentication', async () => {
  let prompts = 0; let factories = 0;
  for (const overrides of [{ RADAR_ALLOW_SLACK_READS: '' }, { RADAR_ALLOW_SLACK_CONNECTION: '' }, { RADAR_APP_ID: 'AOTHER' }, { RADAR_TEAM_ID: 'TOTHER' }, { RADAR_USER_ID: 'UOTHER' }]) {
    assert.equal(await checkUserToken({ env: { ...env, ...overrides }, async readToken() { prompts++; return 'xoxp-public-synthetic'; },
      userPort() { factories++; assert.fail(); }, report() {} }), 1);
  }
  assert.equal(prompts, 0); assert.equal(factories, 0);
});
test('user-only check calls authentication once and never reads a conversation on success or mismatch', async () => {
  for (const [scopes, expectedExit] of [[USER_SCOPES, 0], [['channels:history'], 1], [[...USER_SCOPES, 'search:read'], 1]] as const) {
    let auths = 0; const output: string[] = [];
    assert.equal(await checkUserToken({ env, async readToken() { return 'xoxp-public-synthetic'; },
      userPort() { return { async authTest() { auths++; return { team_id: TARGET.teamId, user_id: TARGET.userId, scopes: [...scopes] }; },
        async replies() { assert.fail('Permission check cannot read messages'); } }; }, report: text => output.push(text) }), expectedExit);
    assert.equal(auths, 1);
    if (expectedExit === 0) assert.ok(output.join('\n').includes('user token verified'));
    else {
      assert.ok(output.join('\n').includes('user_auth/scopes_mismatch'));
      assert.ok(output.join('\n').includes(scopes.length === 1 ? 'missing approved: groups:history, im:history, mpim:history' : 'missing approved: none'));
      assert.ok(output.join('\n').includes(scopes.length === 1 ? 'extra permissions: 0' : 'extra permissions: 1'));
    }
  }
});
test('scope diff prints only fixed catalog names and counts, never unknown remote scope values', () => {
  const privateMaterial = 'synthetic-private-material-never-print';
  const failure = new ScopeMismatchFailure('user_auth', ['channels:history', privateMaterial, privateMaterial, 'search:read'], USER_SCOPES);
  const output = formatStartupFailure(failure, 'runtime');
  assert.ok(output.includes('present approved: channels:history'));
  assert.ok(output.includes('missing approved: groups:history, im:history, mpim:history'));
  assert.ok(output.includes('extra permissions: 2'));
  assert.equal(output.includes(privateMaterial), false);
  assert.ok(output.includes('recognized extra names: search:read')); assert.ok(output.includes('unknown extra names withheld: 1'));
});
test('user-only check recognizes implicit identify without any grant changes or additional API calls', async () => {
  let auths = 0; const output: string[] = [];
  assert.equal(await checkUserToken({ env, async readToken() { return 'xoxp-public-synthetic'; },
    userPort() { return { async authTest() { auths++; return { team_id: TARGET.teamId, user_id: TARGET.userId, scopes: [...USER_SCOPES, 'identify'] }; },
      async replies() { assert.fail(); } }; }, report: text => output.push(text) }), 0);
  assert.equal(auths, 1); assert.ok(output.join('\n').includes('recognized implicit user identity scope: identify'));
  assert.ok(output.join('\n').includes('user token verified'));
});
test('user-only check rejects empty/wrong token before factory and suppresses raw authentication failures', async () => {
  let factories = 0; const output: string[] = [];
  assert.equal(await checkUserToken({ env, async readToken() { return 'xoxb-public-synthetic'; }, userPort() { factories++; assert.fail(); }, report: text => output.push(text) }), 1);
  assert.equal(factories, 0); assert.ok(output.join('\n').includes('user_token/format'));
  output.length = 0;
  const sensitive = 'synthetic-private-material-never-print';
  assert.equal(await checkUserToken({ env, async readToken() { return 'xoxp-public-synthetic'; },
    userPort() { return { async authTest() { throw { code: 'slack_webapi_platform_error', data: { error: 'invalid_auth', access_token: sensitive }, message: sensitive }; }, async replies() { assert.fail(); } }; },
    report: text => output.push(text) }), 1);
  assert.ok(output.join('\n').includes('user_auth/invalid_auth')); assert.equal(output.join('\n').includes(sensitive), false);
});
