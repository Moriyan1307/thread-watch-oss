import { WebClient } from '@slack/web-api';
import type { WebClientOptions } from '@slack/web-api';
import { quietLogger } from './bolt.ts';
import { RetryLater, TARGET } from './types.ts';
import type { Mention, SummarySink, ThreadContext, ThreadMessage, ThreadReader } from './types.ts';
import { ScopeMismatchFailure, StartupFailure, startupFailure } from './diagnostics.ts';
import type { FailurePhase } from './diagnostics.ts';

function validateScopes(actual: readonly string[] | undefined, required: readonly string[], phase: FailurePhase): void {
  if (!actual || !actual.length || actual.every(scope => !scope)) throw new StartupFailure(phase, 'scope_metadata_missing');
  // Slack adds the legacy identify scope in the background for some user
  // tokens. Its ability is inherent to user tokens; it is not an additional
  // requested data/write grant. Normalize only that user-token baseline.
  // https://docs.slack.dev/reference/scopes/identify/
  const effective = phase === 'user_auth' ? actual.filter(scope => scope !== 'identify') : actual;
  try { assertExactScopes(effective, required); }
  catch { throw new ScopeMismatchFailure(phase, effective, required); }
}

export interface SlackReadPort {
  authTest(): Promise<{ team_id?: string; user_id?: string; bot_id?: string; scopes?: string[] }>;
  replies(args: { channel: string; ts: string; limit: number; cursor?: string }): Promise<{
    messages?: { text?: string; ts?: string; user?: string }[];
    has_more?: boolean; response_metadata?: { next_cursor?: string };
  }>;
}
export interface SlackWritePort {
  authTest(): Promise<{ team_id?: string; user_id?: string; bot_id?: string; scopes?: string[] }>;
  openDm(userId: string): Promise<string>;
  postDm(args: { channel: string; text: string; client_msg_id: string }): Promise<void>;
}
export function convertRateLimit(error: unknown): never {
  const e = error as { code?: string; retryAfter?: number };
  if (e?.code === 'slack_webapi_rate_limited_error' && typeof e.retryAfter === 'number') {
    throw new RetryLater(e.retryAfter * 1000);
  }
  throw new Error('slack_operation_failed');
}
// Constructors are inert. validateIdentity() performs an explicit read-only
// auth.test when live access is approved; no token is printed or persisted.
export class SlackThreadReader implements ThreadReader {
  private port: SlackReadPort;
  private validated = false;
  private implicitIdentify = false;
  get hasImplicitIdentify(): boolean { return this.validated && this.implicitIdentify; }
  constructor(port: SlackReadPort) { this.port = port; }
  async validateIdentity(requiredScopes?: readonly string[]): Promise<void> {
    this.validated = false;
    this.implicitIdentify = false;
    let auth;
    try { auth = await this.port.authTest(); } catch (error) { throw startupFailure(error, 'user_auth'); }
    if (auth.team_id !== TARGET.teamId) throw new StartupFailure('user_auth', 'wrong_workspace');
    if (auth.user_id !== TARGET.userId || auth.bot_id) throw new StartupFailure('user_auth', 'wrong_identity');
    if (requiredScopes) validateScopes(auth.scopes, requiredScopes, 'user_auth');
    this.implicitIdentify = Boolean(auth.scopes?.includes('identify'));
    this.validated = true;
  }
  async fetchThread(mention: Mention): Promise<ThreadContext> {
    if (!this.validated || mention.teamId !== TARGET.teamId) throw new Error('Reader not validated');
    const messages: ThreadMessage[] = [];
    let cursor: string | undefined;
    let more = false;
    // Bounded context, with cursor pagination. A long thread may be truncated;
    // the matched message itself is always carried separately in the job.
    try {
      for (let page = 0; page < 3; page++) {
        const result = await this.port.replies({ channel: mention.channelId, ts: mention.threadTs, limit: 15, ...(cursor ? { cursor } : {}) });
        for (const m of result.messages ?? []) {
          if (typeof m.text === 'string' && typeof m.ts === 'string') {
            messages.push({ text: m.text.slice(0,4000), ts: m.ts, ...(m.user ? { user: m.user } : {}) });
            if (messages.length >= 45) break;
          }
        }
        cursor = result.response_metadata?.next_cursor?.trim() || undefined;
        more = Boolean(result.has_more || cursor);
        if (!cursor || messages.length >= 45) break;
      }
    } catch (error) { convertRateLimit(error); }
    return { messages, truncated: more };
  }
}
export class SlackPrivateDmSink implements SummarySink {
  private port: SlackWritePort;
  private approved: boolean;
  private validated = false;
  constructor(port: SlackWritePort, approved = false) { this.port = port; this.approved = approved; }
  async validateIdentity(options?: { botUserId: string; scopes: readonly string[] }): Promise<void> {
    this.validated = false;
    if (!this.approved) throw new Error('Slack delivery approval required');
    let auth;
    try { auth = await this.port.authTest(); } catch (error) { throw startupFailure(error, 'bot_auth'); }
    if (auth.team_id !== TARGET.teamId) throw new StartupFailure('bot_auth', 'wrong_workspace');
    if (!auth.bot_id) throw new StartupFailure('bot_auth', 'wrong_identity');
    if (options) {
      if (auth.user_id !== options.botUserId) throw new StartupFailure('bot_auth', 'wrong_identity');
      validateScopes(auth.scopes, options.scopes, 'bot_auth');
    }
    this.validated = true;
  }
  async sendPrivate(input: { recipientId: string; text: string; idempotencyKey: string }): Promise<void> {
    if (!this.approved || !this.validated || input.recipientId !== TARGET.userId) throw new Error('Private delivery is not approved for this recipient');
    try {
      const channel = await this.port.openDm(TARGET.userId);
      if (!/^D[A-Z0-9]+$/.test(channel)) throw new Error('Expected private DM channel');
      // Stable UUID supplements our queue dedupe; Slack's client_msg_id is not
      // treated as a guarantee of exactly-once posting across ambiguous failures.
      const client_msg_id = await deliveryId(input.idempotencyKey);
      await this.port.postDm({ channel, text: input.text, client_msg_id });
    } catch (error) { convertRateLimit(error); }
  }
}
export async function deliveryId(idempotencyKey: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const hex = createHash('sha256').update(idempotencyKey).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function assertExactScopes(actual: readonly string[] | undefined, required: readonly string[]): void {
  if (!actual || actual.some(s => typeof s !== 'string') ||
      [...new Set(actual)].sort().join(',') !== [...new Set(required)].sort().join(',')) {
    throw new Error('Exact approved scope metadata is required');
  }
}
const sdkOptions: WebClientOptions = { logger: quietLogger, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000, maxRequestConcurrency: 1, allowAbsoluteUrls: false };
export interface SlackRelayPort {
  authTest: SlackWritePort['authTest'];
  postMessage(args: { channel: string; text: string; client_msg_id: string }): Promise<void>;
}
// Inert constructor. The relay validates its approved destination and exact bot
// identity before using either method; no channel/member reads are added here.
export function botRelayPort(token: string): SlackRelayPort {
  const client = new WebClient(token, sdkOptions);
  return {
    async authTest() { const r = await client.auth.test(); return { team_id: r.team_id, user_id: r.user_id, bot_id: r.bot_id, scopes: r.response_metadata?.scopes }; },
    async postMessage(args) {
      await client.chat.postMessage({ ...args, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
    }
  };
}
export function userReadPort(token: string): SlackReadPort {
  const client = new WebClient(token, sdkOptions);
  return {
    async authTest() { const r = await client.auth.test(); return { team_id: r.team_id, user_id: r.user_id, bot_id: r.bot_id, scopes: r.response_metadata?.scopes }; },
    async replies(args) { return client.conversations.replies(args); }
  };
}
export function botWritePort(token: string): SlackWritePort {
  const client = new WebClient(token, sdkOptions);
  return {
    async authTest() { const r = await client.auth.test(); return { team_id: r.team_id, user_id: r.user_id, bot_id: r.bot_id, scopes: r.response_metadata?.scopes }; },
    async openDm(userId) {
      const result = await client.conversations.open({ users: userId });
      if (!result.channel?.id) throw new Error('dm_open_failed');
      return result.channel.id;
    },
    async postDm(args) {
      await client.chat.postMessage({ ...args, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
    }
  };
}
