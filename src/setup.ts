import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { APP_SCOPES, BOT_SCOPES, USER_SCOPES, assertCredential } from './config.ts';
import { readHiddenToken } from './credentials.ts';
import { StartupFailure, formatStartupFailure } from './diagnostics.ts';
import type { FailurePhase } from './diagnostics.ts';
import { botRelayPort, userReadPort, validateScopes } from './slack.ts';

export const SETUP_HELP = `Thread Watch guided configuration
Run npm run setup in your own private Terminal after installing the watcher
from manifest.json and preparing a separate consumer and private relay channel.
The wizard performs only two Slack auth.test calls, discovers installation IDs,
and writes a private, nonsecret .env. It never reads messages, changes scopes,
stores tokens, starts a worker or overwrites an existing configuration.
Have the watcher app ID, consumer bot member ID and relay channel ID ready.
macOS hosting: follow docs/macos.md after setup. AWS: follow docs/aws.md.`;

export async function setup(options: {
  directory?: string; privateTerminal?: boolean;
  ask?: (question: string, signal: AbortSignal) => Promise<string>;
  readToken?: (label: string, signal: AbortSignal) => Promise<string>;
  userPort?: typeof userReadPort; botPort?: typeof botRelayPort;
  report?: (text: string) => void;
} = {}): Promise<number> {
  const report = options.report ?? (text => process.stdout.write(`${text}\n`));
  const path = join(options.directory ?? process.cwd(), '.env');
  const controller = new AbortController(); const stop = () => controller.abort();
  let phase: FailurePhase = 'configuration';
  // A separate readline interface for each public question keeps it closed
  // during hidden credential entry, so no readline listener can echo a token.
  const ask = options.ask ?? (async (question, signal) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    terminal.once('SIGINT', stop);
    try { return await terminal.question(question, { signal }); }
    finally { terminal.close(); }
  });
  const answer = async (question: string) => {
    const value = await ask(question, controller.signal);
    if (controller.signal.aborted) throw new StartupFailure('configuration', 'cancelled');
    return value.trim();
  };
  const confirm = async (question: string) => /^(y|yes)$/i.test(await answer(`${question} [y/N]: `));
  const required = async (question: string) => {
    if (!await confirm(question)) throw new StartupFailure('configuration', 'cancelled');
  };
  const id = async (question: string, prefix: string) => {
    for (;;) {
      const value = await answer(`${question}: `);
      if (new RegExp(`^[${prefix}][A-Z0-9]+$`).test(value)) return value;
      report(`Use the exact Slack ID starting with ${prefix}; names and URLs are not accepted.`);
    }
  };
  const token = async (label: string, tokenPhase: 'user_token' | 'bot_token') => {
    phase = tokenPhase;
    let value: string;
    try { value = await (options.readToken ?? ((label, signal) => readHiddenToken(label, process.stdin, process.stdout, signal)))(label, controller.signal); }
    catch (error) { throw error instanceof StartupFailure ? new StartupFailure(tokenPhase, error.reason) : error; }
    if (controller.signal.aborted) throw new StartupFailure(tokenPhase, 'cancelled');
    assertCredential(value, tokenPhase);
    return value;
  };
  try {
    if (!(options.privateTerminal ?? (process.stdin.isTTY && process.stdout.isTTY))) {
      throw new StartupFailure('configuration', 'private_terminal');
    }
    try {
      lstatSync(path);
      report('Thread Watch setup: .env already exists. It was left untouched. Review it manually, or use a fresh clone for a different installation.');
      return 1;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    report(SETUP_HELP);
    await required('Allow read-only Slack identity and permission checks using the user and watcher-bot tokens you enter?');
    const appId = await id('Watcher app ID (Basic Information on api.slack.com/apps)', 'A');
    const userToken = await token('Slack monitored-user token', 'user_token');
    phase = 'user_auth';
    const user = await (options.userPort ?? userReadPort)(userToken).authTest();
    if (!/^T[A-Z0-9]+$/.test(user.team_id ?? '') || !/^U[A-Z0-9]+$/.test(user.user_id ?? '') || user.bot_id) {
      throw new StartupFailure('user_auth', 'wrong_identity');
    }
    validateScopes(user.scopes, USER_SCOPES, 'user_auth');
    const botToken = await token('Slack watcher-bot token', 'bot_token');
    phase = 'bot_auth';
    const bot = await (options.botPort ?? botRelayPort)(botToken).authTest();
    if (bot.team_id !== user.team_id) throw new StartupFailure('bot_auth', 'wrong_workspace');
    if (!/^U[A-Z0-9]+$/.test(bot.user_id ?? '') || !/^B[A-Z0-9]+$/.test(bot.bot_id ?? '') || bot.user_id === user.user_id) {
      throw new StartupFailure('bot_auth', 'wrong_identity');
    }
    validateScopes(bot.scopes, BOT_SCOPES, 'bot_auth');
    phase = 'configuration';
    report(`Detected workspace ${user.team_id}, monitored user ${user.user_id}, watcher bot ${bot.user_id} (${bot.bot_id}).`);
    const processorId = await id('Separate consumer bot member ID (profile > Copy member ID)', 'U');
    if (processorId === user.user_id || processorId === bot.user_id) {
      report('The consumer must be a different bot from the watcher and monitored user.');
      return 1;
    }
    const relayId = await id('Private relay channel ID (channel details > About)', 'CG');
    const members = [user.user_id!, bot.user_id!, processorId];
    report(`Verify in Slack: ${relayId} is private, belongs to workspace ${user.team_id}, and has exactly these three members: ${members.join(', ')}.`);
    report(`Also verify the consumer belongs to a different app and your app-level token belongs to ${appId} with only ${APP_SCOPES.join(', ')}.`);
    await required('Have you verified all of those facts and that the watcher-bot token belongs to this watcher app?');
    let channels: string[];
    for (;;) {
      const value = await answer('Optional channels to watch every new post in (comma-separated IDs; Enter for mentions only): ');
      channels = value ? [...new Set(value.split(',').map(item => item.trim()))] : [];
      if (value.length <= 4096 && channels.every(channel => /^[CG][A-Z0-9]+$/.test(channel) && channel !== relayId)) break;
      report('Use channel IDs separated by commas; the private relay cannot be a watch channel.');
    }
    const follow = await confirm('Follow later replies in threads where the monitored user was mentioned?');
    report(`Policy: other-human mentions of ${user.user_id}; ${channels.length ? `all new posts in ${channels.join(', ')}` : 'no broad channel monitoring'}; follow mentioned threads: ${follow ? 'yes' : 'no'}.`);
    report('User grants: history for accessible public/private channels and DMs. Slack event text is received transiently; the continuous worker queues and forwards IDs/timestamps only.');
    report(`Destination: private relay ${relayId}. Your separate consumer handles summaries. This step prepares continuous hosting; activation and credential storage are separate.`);
    await required('Approve this access, monitoring policy, private relay delivery and continuous hosting configuration, and save .env?');
    const env: Record<string, string> = {
      RADAR_TEAM_ID: user.team_id!, RADAR_USER_ID: user.user_id!, RADAR_APP_ID: appId,
      RADAR_CONFIRMED_SEPARATE_APP_ID: appId, RADAR_BOT_USER_ID: bot.user_id!, RADAR_BOT_ID: bot.bot_id!,
      RADAR_PROCESSOR_USER_ID: processorId, RADAR_RELAY_CHANNEL_ID: relayId,
      RADAR_RELAY_MEMBER_USER_IDS: members.join(','), RADAR_RELAY_VERIFIED_PRIVATE: 'approved',
      RADAR_VERIFIED_APP_SCOPES: APP_SCOPES.join(','), RADAR_ALLOW_SLACK_CONNECTION: 'approved',
      RADAR_ALLOW_SLACK_READS: 'approved', RADAR_ALLOW_PRIVATE_RELAY: 'approved',
      RADAR_ALLOW_CONTINUOUS: 'approved', RADAR_DEPLOYMENT_APPROVED: 'approved',
      RADAR_WATCH_CHANNEL_IDS: channels.join(','), RADAR_ALLOW_CHANNEL_MONITORING: channels.length ? 'approved' : '',
      RADAR_FOLLOW_MENTION_THREADS: follow ? 'approved' : '', RADAR_ALLOW_PRIVATE_DM: 'denied',
      RADAR_TEST_DURATION_MS: '600000', RADAR_TEST_MAX_SUMMARIES: '1'
    };
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, '# Generated nonsecret installation configuration. No Slack tokens.\n' +
        Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''));
      fsyncSync(fd);
    } catch (error) { unlinkSync(path); throw error; }
    finally { closeSync(fd); }
    report('Thread Watch setup: saved private .env (0600). No tokens were saved and no worker was started.');
    report('Next: docs/macos.md for Mac hosting or docs/aws.md for AWS. Enter all three tokens again only in the host credential tool; setup does not store them.');
    return 0;
  } catch (error) {
    report(formatStartupFailure(controller.signal.aborted ? new StartupFailure(phase, 'cancelled') : error, phase));
    report('Thread Watch setup: incomplete. No worker was started.');
    return 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(`${SETUP_HELP}\n`);
  else if (process.argv.length > 2) { process.stderr.write('Use npm run setup with private prompts, or --help. Tokens and other arguments are not accepted.\n'); process.exitCode = 1; }
  else process.exitCode = await setup();
}
