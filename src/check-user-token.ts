import { pathToFileURL } from 'node:url';
import { USER_SCOPES, assertCredential } from './config.ts';
import { readHiddenToken } from './credentials.ts';
import { StartupFailure, formatStartupFailure } from './diagnostics.ts';
import { SlackThreadReader, userReadPort } from './slack.ts';
import type { SlackReadPort } from './slack.ts';
import { TARGET } from './types.ts';
import { RADAR_BOT } from './relay.ts';

// Owner-run authentication/permission check only. No bot or Socket client,
// queue, conversation reads, grant changes or message sends are constructed.
export async function checkUserToken(options: {
  env?: Record<string, string | undefined>;
  readToken?: (signal: AbortSignal) => Promise<string>;
  userPort?: (token: string) => SlackReadPort;
  report?: (text: string) => void;
} = {}): Promise<number> {
  const env = options.env ?? process.env;
  const report = options.report ?? (text => { process.stdout.write(`${text}\n`); });
  const controller = new AbortController(); const stop = () => controller.abort();
  try {
    if (!/^A[A-Z0-9]+$/.test(RADAR_BOT.appId) || env.RADAR_APP_ID !== RADAR_BOT.appId || env.RADAR_CONFIRMED_SEPARATE_APP_ID !== env.RADAR_APP_ID ||
        env.RADAR_TEAM_ID !== TARGET.teamId || env.RADAR_USER_ID !== TARGET.userId ||
        env.RADAR_ALLOW_SLACK_CONNECTION !== 'approved' || env.RADAR_ALLOW_SLACK_READS !== 'approved') {
      throw new StartupFailure('configuration', 'unexpected');
    }
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const token = await (options.readToken ?? (signal => readHiddenToken('Slack monitored-user token', process.stdin, process.stdout, signal)))(controller.signal);
    if (controller.signal.aborted) throw new StartupFailure('user_token', 'cancelled');
    assertCredential(token, 'user_token');
    const reader = new SlackThreadReader((options.userPort ?? userReadPort)(token));
    await reader.validateIdentity(USER_SCOPES); // Calls only auth.test.
    if (controller.signal.aborted) throw new StartupFailure('user_auth', 'cancelled');
    if (reader.hasImplicitIdentify) report('Radar: recognized implicit user identity scope: identify.');
    report('Radar: user token verified — configured user and workspace, all four approved history scopes and no extra data/write permissions.');
    return 0;
  } catch (error) {
    // The shared hidden input defaults to app_token; identify this sole prompt.
    if (error instanceof StartupFailure && error.phase === 'app_token') error = new StartupFailure('user_token', error.reason);
    report(formatStartupFailure(error, 'user_auth'));
    return 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) { process.stderr.write('Use the hidden prompt; command arguments are not accepted.\n'); process.exitCode = 1; }
  else process.exitCode = await checkUserToken();
}
