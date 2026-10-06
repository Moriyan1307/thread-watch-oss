import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a different installation processes watched posts, mentions and followed replies on fresh durable state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-watch-public-')); chmodSync(directory, 0o700);
  try {
    const initialize = spawnSync('python3', ['-c',
      'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from service import initialize_state; initialize_state(Path(sys.argv[2]))',
      fileURLToPath(new URL('../mac', import.meta.url)), directory], { encoding: 'utf8', timeout: 5000 });
    assert.equal(initialize.status, 0, initialize.stderr);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./alternate-installation.mjs', import.meta.url)), join(directory, 'queue.sqlite')], {
      encoding: 'utf8', timeout: 8000, env: { ...process.env,
        RADAR_TEAM_ID: 'TSECOND001', RADAR_USER_ID: 'USECOND001', RADAR_APP_ID: 'ASECONDAPP',
        RADAR_CONFIRMED_SEPARATE_APP_ID: 'ASECONDAPP', RADAR_BOT_USER_ID: 'USECONDBOT', RADAR_BOT_ID: 'BSECONDBOT',
        RADAR_PROCESSOR_USER_ID: 'USECONDPROC', RADAR_RELAY_CHANNEL_ID: 'CSECONDRELAY',
        RADAR_RELAY_MEMBER_USER_IDS: 'USECOND001,USECONDBOT,USECONDPROC', RADAR_WATCH_CHANNEL_IDS: 'CSECONDWATCH',
        RADAR_DATA_DIRECTORY: '/var/lib/thread-watch'
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'alternate_installation_fresh_state_and_relay_passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing installation identity and unverified relay reject startup before credential access', () => {
  const script = `import assert from 'node:assert/strict';
    const { main } = await import('./src/start-hosted.ts');
    let starts=0;
    assert.equal(await main({preflight:true,start:async()=>{starts++;throw new Error('must not start')},report(){}}),78);
    assert.equal(starts,0);`;
  for (const override of [{ RADAR_TEAM_ID: '' }, { RADAR_BOT_ID: '' }, { RADAR_RELAY_VERIFIED_PRIVATE: 'denied' },
    { RADAR_RELAY_MEMBER_USER_IDS: 'UTEST00001,UTESTBOT01,UOUTSIDER' }]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, RADAR_DATA_DIRECTORY: '/var/lib/thread-watch', ...override }
    });
    assert.equal(child.status, 0, child.stderr);
  }
});
