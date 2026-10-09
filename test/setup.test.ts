import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETUP_HELP, createAppUrl, setup } from '../src/setup.ts';
import { BOT_SCOPES, USER_SCOPES } from '../src/config.ts';

const user = { team_id: 'TSETUP001', user_id: 'USETUP001', scopes: [...USER_SCOPES, 'identify'] };
const bot = { team_id: 'TSETUP001', user_id: 'USETUPBOT', bot_id: 'BSETUPBOT', scopes: [...BOT_SCOPES] };
const userToken = 'xoxp-synthetic-setup-only'; const botToken = 'xoxb-synthetic-setup-only';
function fixture(directory: string, answers = ['yes', 'yes', 'ASETUP001', 'UCONSUMER', 'CRELAY001', 'yes', 'CWATCH001, CWATCH001, GWATCH002', 'yes', 'yes']) {
  const output: string[] = []; let prompts = 0; let auths = 0; let secrets = 0;
  return {
    output, counts: () => ({ prompts, auths, secrets }),
    options: {
      directory, privateTerminal: true,
      async ask() { prompts++; assert.ok(answers.length, 'Unexpected prompt'); return answers.shift()!; },
      async readToken(label: string) { secrets++; return label.includes('monitored-user') ? userToken : botToken; },
      userPort(token: string) { assert.equal(token, userToken); return { async authTest() { auths++; return user; }, async replies() { assert.fail('Setup must not read messages'); } }; },
      botPort(token: string) { assert.equal(token, botToken); return { async authTest() { auths++; return bot; }, async postMessage() { assert.fail('Setup must not send messages'); } }; },
      report(text: string) { output.push(text); }
    }
  };
}
test('prefilled creation link contains exactly the checked-in manifest and needs no terminal or credentials', () => {
  const url = new URL(createAppUrl());
  assert.equal(url.origin + url.pathname, 'https://api.slack.com/apps');
  assert.equal(url.searchParams.get('new_app'), '1');
  assert.deepEqual([...url.searchParams.keys()], ['new_app', 'manifest_json']);
  assert.deepEqual(JSON.parse(url.searchParams.get('manifest_json')!), JSON.parse(readFileSync('manifest.json', 'utf8')));
  const result = spawnSync(process.execPath, ['src/setup.ts', '--create-app-link'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), url.href);
  assert.match(SETUP_HELP, /working separate consumer/i);
});
test('guided setup discovers identities and creates private token-free configuration accepted by existing preflight', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-watch-setup-'));
  try {
    const f = fixture(directory);
    assert.equal(await setup(f.options), 0);
    assert.deepEqual(f.counts(), { prompts: 9, auths: 2, secrets: 2 });
    assert.match(f.output.join('\n'), /OAuth & Permissions/);
    assert.match(f.output.join('\n'), /App-Level Tokens/);
    assert.match(f.output.join('\n'), /does not install or run that service/);
    const file = join(directory, '.env'); const text = readFileSync(file, 'utf8');
    const env = Object.fromEntries(text.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(env.RADAR_TEAM_ID, user.team_id);
    assert.equal(env.RADAR_BOT_ID, bot.bot_id);
    assert.equal(env.RADAR_CONFIRMED_SEPARATE_APP_ID, env.RADAR_APP_ID);
    assert.equal(env.RADAR_RELAY_MEMBER_USER_IDS, `${user.user_id},${bot.user_id},UCONSUMER`);
    assert.equal(env.RADAR_WATCH_CHANNEL_IDS, 'CWATCH001,GWATCH002');
    assert.equal(env.RADAR_ALLOW_PRIVATE_DM, 'denied');
    for (const token of [userToken, botToken]) assert.equal((text + f.output.join('\n')).includes(token), false);
    const preflight = spawnSync(process.execPath, ['src/start-hosted.ts', '--preflight'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, ...env, RADAR_DATA_DIRECTORY: '/var/lib/thread-watch' }
    });
    assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
    const parsed = spawnSync('python3', ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,"mac"); from common import read_configuration; read_configuration(Path(sys.argv[1]))', file], { encoding: 'utf8', timeout: 5000 });
    assert.equal(parsed.status, 0, parsed.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('setup refuses nonprivate terminals, existing files and dangling symlinks before prompts or API access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-watch-setup-'));
  try {
    const f = fixture(directory);
    assert.equal(await setup({ ...f.options, privateTerminal: false }), 1);
    assert.deepEqual(f.counts(), { prompts: 0, auths: 0, secrets: 0 });
    const file = join(directory, '.env'); writeFileSync(file, 'keep-existing');
    assert.equal(await setup(f.options), 1);
    assert.equal(readFileSync(file, 'utf8'), 'keep-existing');
    rmSync(file); symlinkSync(join(directory, 'missing'), file);
    assert.equal(await setup(f.options), 1);
    assert.deepEqual(f.counts(), { prompts: 0, auths: 0, secrets: 0 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('declining any required approval writes nothing; optional monitoring remains off unless chosen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-watch-setup-'));
  try {
    for (const answers of [['no'], ['yes', 'no'], ['yes', 'yes', 'ASETUP001', 'UCONSUMER', 'CRELAY001', 'no'],
      ['yes', 'yes', 'ASETUP001', 'UCONSUMER', 'CRELAY001', 'yes', '', '', 'no']]) {
      const f = fixture(directory, answers);
      const declinedBeforeAuthentication = answers.length <= 2;
      assert.equal(await setup(f.options), 1);
      if (declinedBeforeAuthentication) {
        assert.equal(f.counts().auths, 0);
        assert.equal(f.counts().secrets, 0);
      }
      assert.equal(existsSync(join(directory, '.env')), false);
    }
    const f = fixture(directory, ['yes', 'yes', 'bad-app', 'ASETUP001', 'UCONSUMER', 'CRELAY001', 'yes', 'CRELAY001', '', '', 'yes']);
    assert.equal(await setup(f.options), 0);
    const text = readFileSync(join(directory, '.env'), 'utf8');
    assert.ok(text.includes('RADAR_WATCH_CHANNEL_IDS=\nRADAR_ALLOW_CHANNEL_MONITORING=\nRADAR_FOLLOW_MENTION_THREADS=\n'));
    assert.equal(f.output.some(line => line.includes('bad-app')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('authentication rejects cross-workspace bots, malformed identities, extra scopes and raw secret-bearing failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-watch-setup-'));
  try {
    for (const response of [{ ...bot, team_id: 'TOTHER' }, { ...bot, bot_id: '' }, { ...bot, user_id: user.user_id },
      { ...bot, scopes: [...BOT_SCOPES, 'channels:read'] }]) {
      const f = fixture(directory);
      assert.equal(await setup({ ...f.options, botPort: () => ({ async authTest() { return response; }, async postMessage() { assert.fail(); } }) }), 1);
      assert.equal(existsSync(join(directory, '.env')), false);
    }
    for (const response of [{ ...user, user_id: 'invalid' }, { ...user, bot_id: 'BOTHER' },
      { ...user, scopes: [] }, { ...user, scopes: [...USER_SCOPES, userToken] }]) {
      const f = fixture(directory);
      assert.equal(await setup({ ...f.options, userPort: () => ({ async authTest() { return response; }, async replies() { assert.fail(); } }) }), 1);
      assert.equal(f.counts().secrets, 1);
      assert.equal(f.output.join('\n').includes(userToken), false);
      assert.equal(existsSync(join(directory, '.env')), false);
    }
    const f = fixture(directory);
    assert.equal(await setup({ ...f.options, userPort: () => ({ async authTest() { throw { code: 'slack_webapi_platform_error', data: { error: 'invalid_auth', access_token: userToken }, message: userToken }; }, async replies() { assert.fail(); } }) }), 1);
    assert.ok(f.output.join('\n').includes('user_auth/invalid_auth'));
    assert.equal(f.output.join('\n').includes(userToken), false);
    assert.equal(existsSync(join(directory, '.env')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('actual Terminal questions and hidden token prompts compose without echoing synthetic credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-watch-setup-terminal-'));
  const script = `import { setup } from './src/setup.ts';
    process.exitCode = await setup({ directory: ${JSON.stringify(directory)},
      userPort: () => ({ authTest: async () => (${JSON.stringify(user)}), replies: async () => { throw Error('must not read'); } }),
      botPort: () => ({ authTest: async () => (${JSON.stringify(bot)}), postMessage: async () => { throw Error('must not send'); } }) });`;
  try {
    const result = spawnSync('python3', ['-c', String.raw`
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen([sys.argv[1], '--input-type=module', '-e', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = bytearray()
try:
    for prompt, answer in [
        ('Have you installed the watcher', 'yes'),
        ('Allow read-only Slack identity', 'yes'), ('Watcher app ID (', 'ASETUP001'),
        ('Slack monitored-user token (hidden): ', '${userToken}'),
        ('Slack watcher-bot token (hidden): ', '${botToken}'),
        ('Separate consumer bot member ID (', 'UCONSUMER'), ('Private relay channel ID (', 'CRELAY001'),
        ('Have you verified all', 'yes'), ('Optional channels to watch', ''),
        ('Follow later replies', 'no'), ('Approve this access', 'yes'),
        ('saved private .env (0600)', None)]:
        deadline = time.monotonic() + 10
        chunk = bytearray()
        while prompt.encode() not in chunk:
            if time.monotonic() > deadline: raise AssertionError('Terminal prompt timed out')
            if select.select([master], [], [], 0.1)[0]:
                data = os.read(master, 8192)
                if not data: raise AssertionError('Terminal exited early')
                chunk.extend(data); output.extend(data)
        if answer is not None: os.write(master, (answer + '\n').encode())
    assert child.wait(timeout=5) == 0, 'Terminal setup failed'
    assert b'${userToken}' not in output and b'${botToken}' not in output, 'Hidden credential input was echoed'
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
`, process.execPath, script], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(directory, '.env')));
    assert.equal(statSync(join(directory, '.env')).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
