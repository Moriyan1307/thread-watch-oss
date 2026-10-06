import { pathToFileURL } from 'node:url';
import { promptCredentials } from './credentials.ts';
import { loadRelayTestConfig, startRelayTest } from './relay-runtime.ts';
import { formatStartupFailure } from './diagnostics.ts';
import type { FailurePhase } from './diagnostics.ts';

export async function main(options: {
  env?: Record<string, string | undefined>; readCredentials?: typeof promptCredentials;
  start?: typeof startRelayTest; report?: (text: string) => void;
} = {}): Promise<number> {
  const report = options.report ?? console.log;
  const controller = new AbortController(); const stop = () => controller.abort();
  let phase: FailurePhase = 'configuration';
  try {
    const config = loadRelayTestConfig(options.env ?? process.env);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    phase = 'app_token';
    const credentials = await (options.readCredentials ?? promptCredentials)(controller.signal);
    phase = 'runtime';
    const handle = await (options.start ?? startRelayTest)({ config, credentials, signal: controller.signal,
      onStatus: status => report(`Radar relay: ${status}`) });
    await handle.done; return 0;
  } catch (error) {
    if (phase === 'configuration') report('Radar relay: failed [configuration/unexpected]\nUse run-relay-test.command for the approved bounded test.');
    else report(formatStartupFailure(error, phase));
    return 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) { process.stderr.write('Use the private launcher and hidden prompts; command arguments are not accepted.\n'); process.exitCode = 1; }
  else process.exitCode = await main();
}
