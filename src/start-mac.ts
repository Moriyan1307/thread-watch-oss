import { readFileSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCredentials } from './config.ts';
import type { Credentials } from './config.ts';
import { loadHostedConfig, startHosted } from './hosted.ts';
import { hostedDirectories, assertPrivateDirectory } from './mac-storage.ts';
import { StartupFailure, startupFailure } from './diagnostics.ts';
import type { RuntimeStatus } from './runtime.ts';

export function credentialsFromPipe(raw: string): Credentials {
  if (Buffer.byteLength(raw) > 16384) throw new StartupFailure('configuration', 'format');
  const values: unknown = JSON.parse(raw);
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
      Object.keys(values).sort().join(',') !== 'SLACK_APP_TOKEN,SLACK_BOT_TOKEN,SLACK_USER_TOKEN') {
    throw new StartupFailure('configuration', 'format');
  }
  const v = values as Record<string, string>;
  const credentials = { appToken: v.SLACK_APP_TOKEN!, userToken: v.SLACK_USER_TOKEN!, botToken: v.SLACK_BOT_TOKEN! };
  assertCredentials(credentials); return credentials;
}
export function recordMacStatus(status: RuntimeStatus): void {
  const directory = hostedDirectories('darwin').run; assertPrivateDirectory(directory);
  const temp = join(directory, `status-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify({ status, observedAt: Date.now(), pid: process.pid }), { mode: 0o600, flag: 'wx' });
  renameSync(temp, join(directory, 'status.json'));
}
export async function main(options: {
  env?: Record<string, string | undefined>; start?: typeof startHosted;
  readCredentials?: () => Credentials; report?: (text: string) => void;
  record?: (status: RuntimeStatus) => void; preflight?: boolean;
} = {}): Promise<number> {
  const env = options.env ?? process.env; const report = options.report ?? console.log;
  const controller = new AbortController(); const stop = () => controller.abort();
  let phase: 'configuration' | 'runtime' = 'configuration';
  try {
    if (process.platform !== 'darwin') throw new StartupFailure('configuration', 'unexpected');
    const config = loadHostedConfig(env, 'darwin');
    if (options.preflight) return 0; // No activation, keychain, pipe, store or Slack access.
    if (env.RADAR_MAC_ACTIVATION_APPROVED !== 'approved') throw new StartupFailure('configuration', 'unexpected');
    // The supervisor writes bounded JSON to an anonymous pipe. No tokens in
    // arguments, environment, source files, property lists or status output.
    const credentials = (options.readCredentials ?? (() => {
      try { return credentialsFromPipe(readFileSync(0, 'utf8')); } finally { closeSync(0); }
    }))();
    phase = 'runtime';
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const handle = await (options.start ?? startHosted)({ config, credentials, signal: controller.signal,
      onStatus: status => { report(`Thread Watch macOS: ${status}`); (options.record ?? recordMacStatus)(status); } });
    await handle.done; return 0;
  } catch (error) {
    const failure = startupFailure(error, phase);
    report(`Thread Watch macOS: failed [${failure.phase}/${failure.reason}]`);
    return ['unexpected', 'network', 'rate_limited', 'timeout'].includes(failure.reason) && phase !== 'configuration' ? 1 : 78;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2 && !(process.argv.length === 3 && process.argv[2] === '--preflight')) process.exitCode = 78;
  else process.exitCode = await main({ preflight: process.argv[2] === '--preflight' });
}
