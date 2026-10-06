import { filterMessage, hasExactMention } from './intake.ts';
import { assertRelayConfig, RADAR_BOT, VERIFIED_RELAY } from './relay.ts';
import type { RelayConfig } from './relay.ts';
import type { RadarConfig } from './types.ts';
import type { SqliteQueue } from './store.ts';

// Explicit channel IDs selected by the operator; never fuzzy channel-name matching.
export const APPROVED_WATCH_CHANNELS = Object.freeze((process.env.RADAR_WATCH_CHANNEL_IDS ?? '')
  .split(',').filter(Boolean).map(id => Object.freeze({ name: 'configured', id })));
export interface MonitoringPolicy {
  watchChannelIds: readonly string[];
  channelMonitoringApproved: boolean;
  followMentionThreads: boolean;
}
export function assertMonitoringPolicy(policy: MonitoringPolicy): void {
  if (!Array.isArray(policy.watchChannelIds) || typeof policy.channelMonitoringApproved !== 'boolean' || new Set(policy.watchChannelIds).size !== policy.watchChannelIds.length ||
      policy.watchChannelIds.some(id => !/^[CG][A-Z0-9]+$/.test(id) || !APPROVED_WATCH_CHANNELS.some(channel => channel.id === id) || id === VERIFIED_RELAY.channelId) ||
      (policy.watchChannelIds.length > 0 && !policy.channelMonitoringApproved) || typeof policy.followMentionThreads !== 'boolean') {
    throw new Error('radar_monitoring_policy_invalid');
  }
}
export function loadMonitoringPolicy(env: Record<string, string | undefined>): MonitoringPolicy {
  for (const key of ['RADAR_ALLOW_CHANNEL_MONITORING', 'RADAR_FOLLOW_MENTION_THREADS']) {
    if (env[key] !== undefined && env[key] !== '' && env[key] !== 'approved') throw new Error('radar_monitoring_policy_invalid');
  }
  const policy = Object.freeze({
    watchChannelIds: Object.freeze((env.RADAR_WATCH_CHANNEL_IDS ?? '').split(',').filter(Boolean)),
    channelMonitoringApproved: env.RADAR_ALLOW_CHANNEL_MONITORING === 'approved',
    followMentionThreads: env.RADAR_FOLLOW_MENTION_THREADS === 'approved'
  });
  assertMonitoringPolicy(policy); return policy;
}
export function ingestMonitoredRelay(input: unknown, radar: RadarConfig, relay: RelayConfig,
  policy: MonitoringPolicy, store: SqliteQueue, now: number): 'ignored' | 'queued' | 'duplicate' {
  assertRelayConfig(relay); assertMonitoringPolicy(policy);
  if (radar.appId !== relay.appId) throw new Error('radar_monitoring_policy_invalid');
  const candidate = filterMessage(input, radar);
  if (!candidate || candidate.channelId === relay.channelId ||
      candidate.authorId === RADAR_BOT.userId || candidate.authorId === RADAR_BOT.botId ||
      candidate.botId === RADAR_BOT.botId ||
      candidate.authorId === relay.processorBotUserId) return 'ignored';
  const mentioned = !candidate.isBot && candidate.authorId !== radar.userId && hasExactMention(candidate.text, radar.userId) &&
    (!candidate.isEdit || !hasExactMention(candidate.previousText ?? '', radar.userId));
  // Edits only activate a newly added human mention. Broad channel/thread rules
  // process actual new messages, not parent message_replied metadata or edits.
  if (candidate.isEdit && !mentioned) return 'ignored';
  const watched = !candidate.isEdit && policy.watchChannelIds.includes(candidate.channelId);
  const followed = !candidate.isEdit && policy.followMentionThreads && candidate.threadTs !== candidate.ts &&
    store.followsThread(candidate.teamId, candidate.channelId, candidate.threadTs);
  if (!mentioned && !watched && !followed) return 'ignored';
  const { isBot, isEdit, previousText, botId, ...source } = candidate;
  const monitorReason = mentioned ? 'mention' : watched ? 'watched_channel' : 'followed_thread';
  return store.enqueueMonitored({ ...source, text: '', monitorReason }, now, policy.followMentionThreads && mentioned) ? 'queued' : 'duplicate';
}
