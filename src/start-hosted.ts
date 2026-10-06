import { pathToFileURL } from 'node:url';
import { loadHostedConfig, loadHostedCredentials, recordStatus, startHosted } from './hosted.ts';
import { startupFailure } from './diagnostics.ts';
export async function main(options: {
  env?: Record<string, string | undefined>; start?: typeof startHosted;
  report?: (text: string) => void; record?: typeof recordStatus; preflight?: boolean;
} = {}): Promise<number> {
  const env = options.env ?? process.env; const report = options.report ?? console.log;
  const controller = new AbortController(); const stop = () => controller.abort();
  let phase: 'configuration' | 'runtime' = 'configuration';
  try {
    const config = loadHostedConfig(env);
    if (options.preflight) return 0; // No secrets, filesystem, auth or sockets.
    phase = 'runtime'; const credentials = loadHostedCredentials(env);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const handle = await (options.start ?? startHosted)({ config, credentials, signal: controller.signal,
      onStatus: status => { report(`Radar hosted: ${status}`); (options.record ?? recordStatus)(status); } });
    await handle.done; return 0;
  } catch (error) {
    const failure = startupFailure(error, phase);
    report(`Radar hosted: failed [${failure.phase}/${failure.reason}]`);
    // Configuration/authentication failures wait for a secure owner correction;
    // transient network/runtime failures let systemd restart the process.
    return ['unexpected','network','rate_limited','timeout'].includes(failure.reason) && failure.phase !== 'configuration' ? 1 : 78;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2 && !(process.argv.length === 3 && process.argv[2] === '--preflight')) process.exitCode = 78;
  else process.exitCode = await main({ preflight: process.argv[2] === '--preflight' });
}
