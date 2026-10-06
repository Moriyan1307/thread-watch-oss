import { assertCredential, BOT_SCOPES } from './config.ts';
import { StartupFailure, startupFailure } from './diagnostics.ts';
import { assertExactScopes, botRelayPort, convertRateLimit, deliveryId } from './slack.ts';
import type { SlackRelayPort } from './slack.ts';
import { RetryLater, TARGET } from './types.ts';
import type { Mention } from './types.ts';
import type { DeliveryStore } from './worker.ts';
import { randomUUID } from 'node:crypto';
import { filterMention } from './intake.ts';
import type { QueueStore, RadarConfig } from './types.ts';

// Operator-supplied nonsecret identities, verified against auth.test at startup.
export const RADAR_BOT = Object.freeze({ appId: process.env.RADAR_APP_ID ?? '',
  userId: process.env.RADAR_BOT_USER_ID ?? '', botId: process.env.RADAR_BOT_ID ?? '' });
export interface RelayConfig {
  teamId: string;
  appId: string;
  channelId: string;
  processorBotUserId: string;
  allowRelay: boolean;
  // Supplied only after the operator verifies this exact channel using their
  // authorized Slack connection. The watcher cannot independently inspect members
  // with its existing two bot scopes, and must not request more scopes.
  verification: {
    channelId: string;
    teamId: string;
    isPrivate: boolean;
    memberUserIds: readonly string[];
  };
}
// Verify privacy and exact membership in Slack before making these attestations.
// Existing bot scopes cannot enumerate members; this adds no directory grants.
export const VERIFIED_RELAY: RelayConfig = Object.freeze({
  teamId: TARGET.teamId, appId: RADAR_BOT.appId, channelId: process.env.RADAR_RELAY_CHANNEL_ID ?? '',
  processorBotUserId: process.env.RADAR_PROCESSOR_USER_ID ?? '', allowRelay: process.env.RADAR_ALLOW_PRIVATE_RELAY === 'approved',
  verification: Object.freeze({ channelId: process.env.RADAR_RELAY_CHANNEL_ID ?? '', teamId: TARGET.teamId,
    isPrivate: process.env.RADAR_RELAY_VERIFIED_PRIVATE === 'approved',
    memberUserIds: Object.freeze((process.env.RADAR_RELAY_MEMBER_USER_IDS ?? '').split(',').filter(Boolean)) })
});
export const SYNTHETIC_RELAY_TEXT = [
  'Radar relay test v1',
  'synthetic=true',
  `workspace_id=${TARGET.teamId}`,
  `relay_channel_id=${VERIFIED_RELAY.channelId}`,
  'No source message. No Slack content. No research requested.'
].join('\n');
export function assertRelayConfig(config: RelayConfig): void {
  const verification = config.verification;
  const expected = [TARGET.userId, RADAR_BOT.userId, config.processorBotUserId].sort();
  if (!config.allowRelay || VERIFIED_RELAY.verification.isPrivate !== true ||
      !/^T[A-Z0-9]+$/.test(TARGET.teamId) || !/^U[A-Z0-9]+$/.test(TARGET.userId) ||
      !/^A[A-Z0-9]+$/.test(RADAR_BOT.appId) || !/^U[A-Z0-9]+$/.test(RADAR_BOT.userId) || !/^B[A-Z0-9]+$/.test(RADAR_BOT.botId) ||
      [...VERIFIED_RELAY.verification.memberUserIds].sort().join(',') !== expected.join(',') ||
      config.teamId !== TARGET.teamId || config.appId !== RADAR_BOT.appId ||
      config.channelId !== VERIFIED_RELAY.channelId || config.processorBotUserId !== VERIFIED_RELAY.processorBotUserId ||
      !/^[CG][A-Z0-9]+$/.test(config.channelId) || !/^U[A-Z0-9]+$/.test(config.processorBotUserId) ||
      new Set(expected).size !== 3 || !verification || verification.channelId !== config.channelId ||
      verification.teamId !== TARGET.teamId || verification.isPrivate !== true ||
      !Array.isArray(verification.memberUserIds) || verification.memberUserIds.length !== 3 ||
      [...verification.memberUserIds].sort().join(',') !== expected.join(',')) {
    throw new Error('radar_relay_configuration_unverified');
  }
}
function assertSource(mention: Mention): void {
  if (mention.teamId !== TARGET.teamId || !/^[CGD][A-Z0-9]+$/.test(mention.channelId) ||
      !/^\d{10,16}\.\d{6}$/.test(mention.ts) || !/^\d{10,16}\.\d{6}$/.test(mention.threadTs) ||
      (mention.monitorReason !== undefined && !['mention', 'watched_channel', 'followed_thread'].includes(mention.monitorReason))) {
    throw new Error('radar_relay_source_invalid');
  }
}
export function sourceReference(mention: Mention): string {
  assertSource(mention);
  // No original text, author text, thread content, classifications, arbitrary
  // URLs, Slack metadata API fields, or tool instructions cross this boundary.
  return [
    mention.monitorReason ? 'Radar source v2' : 'Radar source v1',
    `workspace_id=${TARGET.teamId}`,
    `channel_id=${mention.channelId}`,
    `message_ts=${mention.ts}`,
    `thread_ts=${mention.threadTs}`,
    `permalink=https://app.slack.com/archives/${mention.channelId}/p${mention.ts.replace('.', '')}`,
    ...(mention.monitorReason ? [`reason=${mention.monitorReason}`] : [])
  ].join('\n');
}
export function ingestRelay(envelope: unknown, radar: RadarConfig, relay: RelayConfig, store: QueueStore, now: number): 'ignored' | 'queued' | 'duplicate' {
  assertRelayConfig(relay);
  if (radar.appId !== relay.appId || radar.teamId !== TARGET.teamId || radar.userId !== TARGET.userId) throw new Error('radar_relay_configuration_unverified');
  const mention = filterMention(envelope, radar);
  // All bot/self messages are already excluded by filterMention. Exclude the
  // relay itself too, even when a human writes a fresh mention there.
  if (!mention || mention.channelId === relay.channelId) return 'ignored';
  // Relay processing needs IDs only. Never persist original Slack text here.
  return store.enqueue({ ...mention, text: '' }, now) ? 'queued' : 'duplicate';
}
export class SlackMetadataRelaySink {
  private readonly config: RelayConfig;
  private readonly port: SlackRelayPort;
  private validated = false;
  private readonly syntheticId = randomUUID();
  constructor(options: { config: RelayConfig; botToken: string; portFactory?: (token: string) => SlackRelayPort }) {
    // Destination verification comes before credential inspection/factories.
    assertRelayConfig(options.config);
    assertCredential(options.botToken, 'bot_token');
    // Copy the approved values so callers cannot redirect a validated sink.
    this.config = Object.freeze({ ...options.config,
      verification: Object.freeze({ ...options.config.verification,
        memberUserIds: Object.freeze([...options.config.verification.memberUserIds]) }) });
    this.port = (options.portFactory ?? botRelayPort)(options.botToken);
  }
  assertReady(): void {
    assertRelayConfig(this.config);
    if (!this.validated) throw new Error('radar_relay_identity_unverified');
  }
  assertSource(mention: Mention): void {
    this.assertReady();
    assertSource(mention);
    if (mention.channelId === this.config.channelId) throw new Error('radar_relay_loop_blocked');
  }
  async validateIdentity(): Promise<void> {
    this.validated = false;
    let auth;
    try { auth = await this.port.authTest(); } catch (error) { throw startupFailure(error, 'bot_auth'); }
    if (auth.team_id !== TARGET.teamId) throw new StartupFailure('bot_auth', 'wrong_workspace');
    if (auth.user_id !== RADAR_BOT.userId || auth.bot_id !== RADAR_BOT.botId) throw new StartupFailure('bot_auth', 'wrong_identity');
    if (!auth.scopes?.length) throw new StartupFailure('bot_auth', 'scope_metadata_missing');
    try { assertExactScopes(auth.scopes, BOT_SCOPES); } catch { throw new StartupFailure('bot_auth', 'scopes_mismatch'); }
    this.validated = true;
  }
  async sendSource(mention: Mention, idempotencyKey: string): Promise<void> {
    this.assertSource(mention);
    const text = sourceReference(mention);
    try {
      await this.port.postMessage({ channel: this.config.channelId, text,
        client_msg_id: await deliveryId(`relay:${this.config.channelId}:${idempotencyKey}`) });
    } catch (error) { convertRateLimit(error); }
  }
  async sendSyntheticTest(): Promise<void> {
    this.assertReady();
    // This owner-run test never reads messages or opens a DM. It posts one
    // fixed benign payload to the exact verified relay and never retries.
    if (this.config.channelId !== VERIFIED_RELAY.channelId ||
        this.config.processorBotUserId !== VERIFIED_RELAY.processorBotUserId) throw new Error('radar_relay_test_destination_invalid');
    try {
      await this.port.postMessage({ channel: VERIFIED_RELAY.channelId,
        text: SYNTHETIC_RELAY_TEXT, client_msg_id: this.syntheticId });
    } catch (error) { convertRateLimit(error); }
  }
}
export async function workOneRelay(options: {
  store: DeliveryStore; sink: SlackMetadataRelaySink; signal?: AbortSignal;
  clock?: () => number; maxAttempts?: number;
}): Promise<'idle' | 'sent' | 'retry' | 'uncertain'> {
  // Relay mode sends references to the verified destination. No thread reader
  // or research provider exists in this path.
  options.sink.assertReady();
  if (options.signal?.aborted) return 'idle';
  const clock = options.clock ?? Date.now;
  const job = options.store.claim(clock());
  if (!job) return 'idle';
  let sending = false;
  try {
    options.sink.assertSource(job.mention);
    if (options.signal?.aborted) {
      options.store.retry(job.id, clock() + 60_000, options.maxAttempts ?? 5);
      return 'retry';
    }
    options.store.beginSending(job.id);
    sending = true;
    await options.sink.sendSource(job.mention, job.id);
    options.store.complete(job.id, clock());
    return 'sent';
  } catch (error) {
    if (sending && !(error instanceof RetryLater)) {
      options.store.markUncertain(job.id);
      return 'uncertain';
    }
    const backoff = error instanceof RetryLater ? error.delayMs : Math.min(60_000 * 2 ** (job.attempts - 1), 3_600_000);
    options.store.retry(job.id, clock() + backoff, options.maxAttempts ?? 5);
    return 'retry';
  }
}
