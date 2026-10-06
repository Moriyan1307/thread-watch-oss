import { pathToFileURL } from 'node:url';
import { readHiddenToken } from './credentials.ts';
import { assertCredential } from './config.ts';
import { startupFailure } from './diagnostics.ts';
import type { FailurePhase } from './diagnostics.ts';
import { assertRelayConfig, SlackMetadataRelaySink, VERIFIED_RELAY } from './relay.ts';
import { RetryLater } from './types.ts';
import type { RelayConfig } from './relay.ts';
import type { SlackRelayPort } from './slack.ts';

export async function main(options: {
  env?: Record<string, string | undefined>; config?: RelayConfig;
  readToken?: () => Promise<string>; portFactory?: (token: string) => SlackRelayPort;
  report?: (text: string) => void;
} = {}): Promise<number> {
  const env = options.env ?? process.env;
  const report = options.report ?? console.log;
  const config = options.config ?? VERIFIED_RELAY;
  let phase: FailurePhase = 'configuration';
  let posting = false;
  try {
    // Test approval is separate from the existing user-DM test. Do not let the
    // owner's local DM flags silently enable a different destination.
    if (env.RADAR_ALLOW_RELAY_TEST !== 'approved' || config.channelId !== VERIFIED_RELAY.channelId ||
        config.processorBotUserId !== VERIFIED_RELAY.processorBotUserId) throw new Error('relay_test_not_approved');
    assertRelayConfig(config);
    phase = 'bot_token';
    const botToken = await (options.readToken ?? (() => readHiddenToken('Radar bot token')) )();
    assertCredential(botToken, 'bot_token');
    const sink = new SlackMetadataRelaySink({ config, botToken, ...(options.portFactory ? { portFactory: options.portFactory } : {}) });
    phase = 'bot_auth';
    await sink.validateIdentity();
    phase = 'runtime'; posting = true;
    await sink.sendSyntheticTest();
    report('Radar relay: synthetic test sent');
    report(`Radar relay: sent_at_utc ${new Date().toISOString()}`);
    report('Destination: the configured private relay. Check your consumer for its acknowledgement.');
    return 0;
  } catch (error) {
    if (posting) {
      report(error instanceof RetryLater ? 'Radar relay: rate limited; no automatic retry.' :
        'Radar relay: delivery uncertain; check radar-relay before repeating.');
    } else {
      const failure = startupFailure(error, phase);
      report(`Radar relay: failed [${failure.phase}/${failure.reason}]`);
    }
    report('Keep tokens private. Share only the Radar relay status line.');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
