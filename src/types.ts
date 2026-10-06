export type Category = 'attention' | 'question' | 'task' | 'reminder';
export interface RadarConfig {
  teamId: string;
  userId: string;
  appId: string;
  channelTypes: readonly string[];
}
// Immutable per-process installation inputs. No installation is enabled by default.
export const TARGET = Object.freeze({ teamId: process.env.RADAR_TEAM_ID ?? '', userId: process.env.RADAR_USER_ID ?? '' });
export interface Mention {
  eventId: string;
  messageKey: string;
  teamId: string;
  channelId: string;
  channelType: string;
  authorId: string;
  text: string;
  ts: string;
  threadTs: string;
  monitorReason?: 'mention' | 'watched_channel' | 'followed_thread';
}
export interface ThreadMessage { text: string; ts: string; user?: string }
export interface ThreadContext { messages: ThreadMessage[]; truncated: boolean }
export interface Classification {
  categories: Category[];
  urgency: 'normal' | 'high';
  method: 'local-rules';
  deadlineText?: string;
}
export interface ResearchResult { status: 'disabled' | 'completed'; text?: string; sources?: string[] }
export interface ResearchProvider {
  readonly id: string;
  readonly external: boolean;
  research(input: { mention: Mention; thread: ThreadContext; classification: Classification }): Promise<ResearchResult>;
}
export interface ThreadReader { fetchThread(mention: Mention): Promise<ThreadContext> }
export interface SummarySink {
  sendPrivate(input: { recipientId: string; text: string; idempotencyKey: string }): Promise<void>;
}
export interface PreparedResult { text: string; classification: Classification; research: ResearchResult }
export interface Job { id: string; mention: Mention; attempts: number; prepared?: PreparedResult }
export interface QueueStore {
  enqueue(mention: Mention, now: number): boolean;
  claim(now: number): Job | undefined;
  savePrepared(id: string, prepared: PreparedResult): void;
  complete(id: string, now: number): void;
  retry(id: string, availableAt: number, maxAttempts: number): void;
}
export class RetryLater extends Error {
  readonly delayMs: number;
  constructor(delayMs: number) { super('retry_later'); this.delayMs = Math.max(1_000, delayMs); }
}
