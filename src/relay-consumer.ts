import { assertRelayConfig, RADAR_BOT, sourceReference, SYNTHETIC_RELAY_TEXT, VERIFIED_RELAY } from './relay.ts';
import { loadMonitoringPolicy } from './monitoring.ts';
import { TARGET } from './types.ts';
import type { Mention, QueueStore } from './types.ts';
import { workOne } from './worker.ts';
import type { WorkerOptions } from './worker.ts';

// Obtain this metadata from an authenticated Slack event/API response. A webhook
// body or claimed author in text does not establish sender identity.
export interface RelayMessage {
  teamId: string; channelId: string; userId: string; ts: string; text: string;
  threadTs?: string; botId?: string; subtype?: string;
}
export function parseRelayMessage(message: RelayMessage): Mention | undefined {
  assertRelayConfig(VERIFIED_RELAY);
  if (!message || message.teamId !== TARGET.teamId || message.channelId !== VERIFIED_RELAY.channelId ||
      message.userId !== RADAR_BOT.userId || typeof message.ts !== 'string' || !/^\d{10,16}\.\d{6}$/.test(message.ts) ||
      (message.threadTs !== undefined && message.threadTs !== message.ts) ||
      (message.botId !== undefined && message.botId !== RADAR_BOT.botId) ||
      (message.subtype !== undefined && message.subtype !== 'bot_message') ||
      typeof message.text !== 'string' || message.text.length > 2048) throw new Error('relay_consumer_unverified_message');
  if (message.text === SYNTHETIC_RELAY_TEXT) return;
  const lines = message.text.split('\n');
  const version = lines[0] === 'Radar source v1' ? 1 : lines[0] === 'Radar source v2' ? 2 : 0;
  if (!version || lines.length !== (version === 1 ? 6 : 7)) throw new Error('relay_consumer_invalid_reference');
  const value = (index: number, key: string) => lines[index]?.startsWith(key + '=') ? lines[index]!.slice(key.length + 1) : '';
  const teamId = value(1, 'workspace_id'), channelId = value(2, 'channel_id'), ts = value(3, 'message_ts');
  const messageKey = `${teamId}:${channelId}:${ts}`;
  const mention: Mention = { eventId: 'relay:' + messageKey, messageKey, teamId, channelId,
    channelType: channelId.startsWith('D') ? 'im' : 'channel', authorId: 'unknown', text: '',
    ts, threadTs: value(4, 'thread_ts'),
    ...(version === 2 ? { monitorReason: value(6, 'reason') as Mention['monitorReason'] } : {}) };
  const policy = loadMonitoringPolicy(process.env);
  if (channelId === VERIFIED_RELAY.channelId || sourceReference(mention) !== message.text ||
      (mention.monitorReason === 'watched_channel' && !policy.watchChannelIds.includes(channelId)) ||
      (mention.monitorReason === 'followed_thread' && (!policy.followMentionThreads || mention.threadTs === ts))) {
    throw new Error('relay_consumer_invalid_reference');
  }
  return mention;
}
export function ingestRelayMessage(message: RelayMessage, store: QueueStore, now = Date.now()): 'ignored' | 'queued' | 'duplicate' {
  const mention = parseRelayMessage(message);
  return !mention ? 'ignored' : store.enqueue(mention, now) ? 'queued' : 'duplicate';
}
export async function workOneReference(options: WorkerOptions): ReturnType<typeof workOne> {
  // Reuse preparation, private-recipient enforcement, retry and uncertain-send
  // quarantine. The consumer stores a prepared summary; the producer stores IDs.
  return workOne({ ...options, reader: { async fetchThread(mention) {
    const thread = await options.reader.fetchThread(mention);
    const source = thread.messages.find(message => message.ts === mention.ts);
    if (!source) throw new Error('relay_consumer_source_unavailable');
    mention.text = source.text;
    mention.authorId = source.user ?? 'unknown';
    return thread;
  } } });
}
