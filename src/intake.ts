import { TARGET } from './types.ts';
import type { Mention, QueueStore, RadarConfig } from './types.ts';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
const id = (v: unknown, prefix: string) => typeof v === 'string' && new RegExp(`^${prefix}[A-Z0-9]+$`).test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d{6}$/.test(v);
export function assertConfig(config: RadarConfig): void {
  if (!id(TARGET.teamId, 'T') || !id(TARGET.userId, 'U') || config.teamId !== TARGET.teamId || config.userId !== TARGET.userId || !id(config.appId, 'A') || config.appId === 'AUNCONFIGURED') {
    throw new Error('Confirmed separate app and fixed target workspace/user are required');
  }
  if (!config.channelTypes.length || config.channelTypes.some(t => !['channel', 'group', 'im', 'mpim'].includes(t))) {
    throw new Error('Unsupported channel types');
  }
}
export function hasExactMention(text: string, userId: string): boolean {
  return text.includes(`<@${userId}>`);
}
export interface MessageCandidate extends Mention { isBot: boolean; isEdit: boolean; previousText?: string; botId?: string }
export function filterMessage(input: unknown, config: RadarConfig): MessageCandidate | undefined {
  assertConfig(config);
  const body = record(input);
  if (!body || body.type !== 'event_callback' || body.team_id !== config.teamId || body.api_app_id !== config.appId || !id(body.event_id, 'Ev')) return;
  // Fail closed on omitted, bot-only, or another user's installation authorization.
  // This single-user app must never be installed for other users. Slack truncates
  // this list for multi-install apps; resolving that would require extra access.
  if (!Array.isArray(body.authorizations) || body.authorizations.length !== 1 || !body.authorizations.every(a => {
    const auth = record(a);
    return auth?.team_id === config.teamId && auth.user_id === config.userId && auth.is_bot === false;
  })) return;
  let event = record(body.event);
  if (!event || event.type !== 'message' || !config.channelTypes.includes(String(event.channel_type))) return;
  const channelType = String(event.channel_type);
  const channelId = event.channel;
  if (!id(channelId, '[CGD]')) return;
  let previousText: string | undefined;
  const isEdit = event.subtype === 'message_changed';
  if (event.subtype === 'message_changed') {
    const previous = record(event.previous_message);
    if (typeof previous?.text !== 'string') return;
    previousText = previous.text;
    event = record(event.message);
    if (!event) return;
  }
  // Broadcast copies share a message key with the thread original.
  if (event.subtype !== undefined && !['file_share', 'thread_broadcast', 'reply_broadcast', 'bot_message'].includes(String(event.subtype))) return;
  const isBot = event.bot_id !== undefined || event.subtype === 'bot_message';
  if (event.bot_id !== undefined && !id(event.bot_id, 'B')) return;
  if (event.subtype === 'bot_message' && !id(event.bot_id, 'B')) return;
  if (event.user !== undefined && !id(event.user, '[UW]')) return;
  if (!id(event.user, '[UW]') && !id(event.bot_id, 'B')) return;
  if (event.text !== undefined && typeof event.text !== 'string') return;
  const text = typeof event.text === 'string' ? event.text : '';
  if (text.length > 40_000 || !timestamp(event.ts)) return;
  if (event.thread_ts !== undefined && !timestamp(event.thread_ts)) return;
  return {
    eventId: body.event_id as string,
    messageKey: `${config.teamId}:${channelId}:${event.ts}`,
    teamId: config.teamId,
    channelId: channelId as string,
    channelType,
    authorId: (event.user ?? event.bot_id) as string,
    text,
    ts: event.ts,
    threadTs: (event.thread_ts as string | undefined) ?? event.ts,
    isBot, isEdit, ...(previousText !== undefined ? { previousText } : {}), ...(event.bot_id ? { botId: event.bot_id as string } : {})
  };
}
export function filterMention(input: unknown, config: RadarConfig): Mention | undefined {
  const candidate = filterMessage(input, config);
  if (!candidate || candidate.isBot || candidate.authorId === config.userId || !hasExactMention(candidate.text, config.userId) ||
      (candidate.isEdit && hasExactMention(candidate.previousText ?? '', config.userId))) return;
  const { isBot, isEdit, previousText, botId, ...mention } = candidate;
  return mention;
}
export function ingest(input: unknown, config: RadarConfig, store: QueueStore, now = Date.now()): 'ignored' | 'queued' | 'duplicate' {
  const mention = filterMention(input, config);
  if (!mention) return 'ignored';
  return store.enqueue(mention, now) ? 'queued' : 'duplicate';
}
