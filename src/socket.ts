import { SocketModeClient } from '@slack/socket-mode';
import { quietLogger } from './bolt.ts';
import { APP_SCOPES } from './config.ts';
import { assertConfig, ingest } from './intake.ts';
import { assertExactScopes } from './slack.ts';
import { within } from './lifecycle.ts';
import type { QueueStore, RadarConfig } from './types.ts';
import { StartupFailure, startupFailure } from './diagnostics.ts';

export interface SocketDelivery { type: string; body: unknown; ack(): Promise<void> }
export type SocketStatus = 'queue_failed' | 'ack_failed' | 'socket_error' | 'socket_identity_failed';
export interface SocketHandlers {
  envelope(delivery: SocketDelivery): void;
  disconnected(): void;
  fatal(): void;
  error(): void;
}
export interface SocketPort {
  setHandlers(handlers: SocketHandlers): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
// Slack's SDK otherwise discards the hello app ID. Check it before allowing
// connected/event callbacks, so an unrelated app-level token fails closed.
export class IdentifiedClient extends SocketModeClient {
  private expectedAppId: string;
  constructor(appToken: string, appId: string, signal: AbortSignal) {
    super({ appToken, logger: quietLogger, autoReconnectEnabled: false, pingPongLoggingEnabled: false,
      clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000, allowAbsoluteUrls: false,
        fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) } });
    this.expectedAppId = appId;
  }
  protected override async onWebSocketMessage(data: string | ArrayBuffer, isBinary: boolean): Promise<void> {
    try {
      if (!isBinary) {
        let parsed: unknown;
        try { parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
        const message = object(parsed);
        if (message?.type === 'hello' && object(message.connection_info)?.app_id !== this.expectedAppId) {
          this.emit('radar_identity_failed');
          await this.disconnect();
          return;
        }
      }
      await super.onWebSocketMessage(data, isBinary);
    } catch {
      // EventEmitter does not await async listeners. Consume all rejections and
      // report a constant label, never raw payloads, URLs, credentials or errors.
      this.emit('radar_identity_failed');
      await this.disconnect().catch(() => {});
    }
  }
}
export function createSocketPort(appToken: string, appId: string): SocketPort {
  // Construction is inert. App-level scope metadata is checked when reported;
  // the owner must also attest the exact credential scopes in local config.
  let handlers: SocketHandlers | undefined;
  let failedIdentity = false;
  let identityFailure: StartupFailure | undefined;
  let client: IdentifiedClient | undefined;
  let connectionAbort: AbortController | undefined;
  let generation = 0;
  return {
    setHandlers(value) { handlers = value; },
    async connect() {
      if (failedIdentity) throw identityFailure ?? new StartupFailure('socket', 'wrong_app');
      const currentGeneration = ++generation;
      connectionAbort = new AbortController();
      const activeClient = new IdentifiedClient(appToken, appId, connectionAbort.signal);
      client = activeClient;
      activeClient.on('authenticated', (response: { response_metadata?: { scopes?: string[] } }) => {
        if (response.response_metadata?.scopes) {
          try { assertExactScopes(response.response_metadata.scopes, APP_SCOPES); }
          catch { failedIdentity = true; identityFailure = new StartupFailure('socket', 'scopes_mismatch'); handlers?.fatal(); throw identityFailure; }
        }
      });
      activeClient.on('radar_identity_failed', () => { failedIdentity = true; identityFailure = new StartupFailure('socket', 'wrong_app'); handlers?.fatal(); });
      activeClient.on('slack_event', (delivery: SocketDelivery) => handlers?.envelope(delivery));
      activeClient.on('disconnected', () => handlers?.disconnected());
      activeClient.on('error', () => handlers?.error());
      await within(activeClient.start(), 20_000).catch(error => { throw identityFailure ?? startupFailure(error, 'socket'); });
      if (failedIdentity || currentGeneration !== generation) throw identityFailure ?? new StartupFailure('socket', 'wrong_app');
    },
    async disconnect() {
      generation++; connectionAbort?.abort();
      if (client) await within(client.disconnect(), 5_000);
    }
  };
}
export class SocketIngress {
  private config: RadarConfig;
  private store: QueueStore;
  private port: SocketPort;
  private accepting = false;
  private pending = new Set<Promise<void>>();
  private status: (status: SocketStatus) => void;
  private fatal: () => void;
  private route: (body: unknown, store: QueueStore, now: number) => void;
  constructor(options: { config: RadarConfig; store: QueueStore; port: SocketPort; clock?: () => number;
    onStatus?: (status: SocketStatus) => void; onDisconnected?: () => void; onFatal?: () => void;
    route?: (body: unknown, store: QueueStore, now: number) => void }) {
    assertConfig(options.config);
    this.config = options.config; this.store = options.store; this.port = options.port;
    this.status = options.onStatus ?? (() => {}); this.fatal = options.onFatal ?? (() => {});
    this.route = options.route ?? ((body, store, now) => { ingest(body, this.config, store, now); });
    this.port.setHandlers({
      envelope: delivery => {
        const promise = this.receive(delivery, options.clock ?? Date.now);
        this.pending.add(promise);
        void promise.then(() => this.pending.delete(promise));
      },
      disconnected: () => { this.accepting = false; options.onDisconnected?.(); },
      error: () => this.status('socket_error'),
      fatal: () => { this.accepting = false; this.status('socket_identity_failed'); this.fatal(); }
    });
  }
  async connect(): Promise<void> {
    this.accepting = true;
    try { await this.port.connect(); }
    catch (error) { this.accepting = false; await within(this.port.disconnect(), 5_000).catch(() => {}); throw startupFailure(error, 'socket'); }
  }
  private async receive(delivery: SocketDelivery, clock: () => number): Promise<void> {
    if (!this.accepting || typeof delivery?.ack !== 'function') return;
    try {
      if (delivery.type === 'events_api') this.route(delivery.body, this.store, clock());
    } catch {
      // No ack after a failed durable write. Stop processing and let Slack retry
      // after recovery; context/research/sends never happen in this callback.
      this.accepting = false; this.status('queue_failed'); this.fatal(); return;
    }
    try { await within(delivery.ack(), 2_000); }
    catch { this.status('ack_failed'); } // Saved work stays deduped on Slack retry.
  }
  async stop(): Promise<void> {
    this.accepting = false;
    await within(this.port.disconnect(), 5_000).catch(() => {});
    await Promise.all(this.pending);
  }
  async settled(): Promise<void> { await Promise.all(this.pending); }
}
