import { fileURLToPath } from 'node:url';
import { assertBoundedConfig, assertMonitorConfig, assertCredentials, assertLocalConfig, BOT_SCOPES, USER_SCOPES } from './config.ts';
import type { BoundedConfig, MonitorConfig, Credentials, LocalConfig } from './config.ts';
import { delay } from './lifecycle.ts';
import { openLocalStore } from './local-store.ts';
import { SlackPrivateDmSink, SlackThreadReader, botWritePort, userReadPort } from './slack.ts';
import type { SlackReadPort, SlackWritePort } from './slack.ts';
import { createSocketPort, SocketIngress } from './socket.ts';
import type { SocketPort, SocketStatus } from './socket.ts';
import type { SqliteQueue } from './store.ts';
import { workOne } from './worker.ts';
import { StartupFailure, startupFailure } from './diagnostics.ts';
import type { FailurePhase } from './diagnostics.ts';
import type { QueueStore } from './types.ts';

export type RuntimeStatus = SocketStatus | 'started' | 'sent' | 'retry' | 'uncertain' | 'reconnecting' | 'stopped' | 'runtime_failed';
export interface RuntimeDependencies {
  userPort(token: string): SlackReadPort;
  botPort(token: string): SlackWritePort;
  socketPort(token: string, appId: string): SocketPort;
  store(): { queue: SqliteQueue; close(): void };
}
export interface RuntimeHandle { done: Promise<void>; stop(): Promise<void> }
const defaultDependencies: RuntimeDependencies = {
  userPort: userReadPort, botPort: botWritePort, socketPort: createSocketPort,
  store: () => openLocalStore(fileURLToPath(new URL('../data/', import.meta.url)))
};
export async function startLocalTest(options: {
  config: LocalConfig; credentials: Credentials; dependencies?: RuntimeDependencies;
  signal?: AbortSignal; onStatus?: (status: RuntimeStatus) => void; pollMs?: number;
}): Promise<RuntimeHandle> {
  // Validate every gate before constructing clients, touching data or using auth.
  assertLocalConfig(options.config); assertCredentials(options.credentials);
  if (options.signal?.aborted) throw new Error('local_test_cancelled');
  const deps = options.dependencies ?? defaultDependencies;
  const reader = new SlackThreadReader(deps.userPort(options.credentials.userToken));
  const sink = new SlackPrivateDmSink(deps.botPort(options.credentials.botToken), true);
  return startBoundedRuntime({ ...options, store: deps.store,
    socket: () => deps.socketPort(options.credentials.appToken, options.config.appId),
    async authenticate(setPhase) {
      await reader.validateIdentity(USER_SCOPES);
      if (options.signal?.aborted) throw new Error('local_test_cancelled');
      setPhase('bot_auth');
      await sink.validateIdentity({ botUserId: options.config.botUserId, scopes: BOT_SCOPES });
    },
    work: (store, signal) => workOne({ store, reader, sink, allowPrivateDelivery: true, signal })
  });
}
// Shared lifecycle for separately gated DM and relay entry points. Callers
// validate their own destination/credentials before constructing dependencies.
export interface MonitorRuntimeOptions {
  config: MonitorConfig; store: RuntimeDependencies['store']; socket(): SocketPort;
  authenticate(setPhase: (phase: FailurePhase) => void): Promise<void>;
  work(store: SqliteQueue, signal: AbortSignal): ReturnType<typeof workOne>;
  route?: (body: unknown, store: QueueStore, now: number) => void;
  signal?: AbortSignal; onStatus?: (status: RuntimeStatus) => void; pollMs?: number;
}
export async function startBoundedRuntime(options: Omit<MonitorRuntimeOptions, 'config'> & { config: BoundedConfig }): Promise<RuntimeHandle> {
  assertBoundedConfig(options.config);
  return startMonitorRuntime({ ...options, limits: { durationMs: options.config.durationMs, maxSummaries: options.config.maxSummaries } });
}
// The headless entry point has its own continuous-operation/destination gates.
// Local test entry points always supply their original limits.
export async function startMonitorRuntime(options: MonitorRuntimeOptions & { limits?: { durationMs: number; maxSummaries: number } }): Promise<RuntimeHandle> {
  assertMonitorConfig(options.config);
  if (options.limits) assertBoundedConfig({ ...options.config, ...options.limits });
  const status = options.onStatus ?? (() => {});
  let resource: ReturnType<RuntimeDependencies['store']> | undefined;
  let ingress: SocketIngress | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  controller.signal.addEventListener('abort', () => { void ingress?.stop().catch(() => {}); }, { once: true });
  options.signal?.addEventListener('abort', abort, { once: true });
  let disconnected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let phase: FailurePhase = 'user_auth';
  let failed = false;
  try {
    await options.authenticate(value => { phase = value; });
    if (options.signal?.aborted) throw new Error('local_test_cancelled');
    phase = 'local_storage'; resource = options.store();
    resource.queue.expire(Date.now(), 24 * 60 * 60 * 1000);
    phase = 'socket'; ingress = new SocketIngress({ config: options.config, store: resource.queue,
      port: options.socket(), ...(options.route ? { route: options.route } : {}),
      onStatus: status, onDisconnected: () => { disconnected = true; }, onFatal: () => { failed = true; abort(); } });
    await ingress.connect();
    if (controller.signal.aborted || options.signal?.aborted) throw new Error('local_test_cancelled');
    status('started');
    if (options.limits) timer = setTimeout(abort, options.limits.durationMs);
    const pollMs = Math.max(10, Math.min(options.pollMs ?? 1_000, 5_000));
    const activeResource = resource; const activeIngress = ingress;
    const reconnect = async () => {
      let backoff = 1_000;
      while (!controller.signal.aborted) {
        await delay(pollMs, controller.signal);
        if (controller.signal.aborted || !disconnected) continue;
        status('reconnecting');
        try { await activeIngress.connect(); disconnected = false; backoff = 1_000; }
        catch { await delay(backoff, controller.signal); backoff = Math.min(30_000, backoff * 2); }
      }
    };
    const worker = async () => {
      let deliveredOrAmbiguous = 0; let lastExpiry = Date.now();
      while (!controller.signal.aborted) {
        if (Date.now() - lastExpiry > 60_000) {
          activeResource.queue.expire(Date.now(), 24 * 60 * 60 * 1000); lastExpiry = Date.now();
        }
        const result = await options.work(activeResource.queue, controller.signal);
        if (result !== 'idle' && result !== 'prepared') status(result);
        if (result === 'sent' || result === 'uncertain') {
          deliveredOrAmbiguous++;
          if (options.limits && deliveredOrAmbiguous >= options.limits.maxSummaries) abort();
        }
        if (result === 'idle' || result === 'retry') await delay(pollMs, controller.signal);
      }
    };
    const supervised = (task: () => Promise<void>) => task().catch(() => { failed = true; status('runtime_failed'); abort(); });
    const done = Promise.all([supervised(reconnect), supervised(worker)]).then(async () => {
      clearTimeout(timer); controller.abort();
      await activeIngress.stop();
      activeResource.close(); options.signal?.removeEventListener('abort', abort); status('stopped');
      if (failed) throw new StartupFailure('runtime', 'unexpected');
    });
    return { done, async stop() { abort(); await done; } };
  } catch (error) {
    const failure = options.signal?.aborted ? new StartupFailure(phase, 'cancelled') : startupFailure(error, phase);
    clearTimeout(timer); controller.abort();
    await ingress?.stop().catch(() => {});
    try { resource?.close(); } catch { /* Preserve the safe startup diagnostic. */ }
    options.signal?.removeEventListener('abort', abort);
    throw failure;
  }
}
