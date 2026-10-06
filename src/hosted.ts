import { fstatSync, lstatSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { assertCredentials, assertMonitorConfig, USER_SCOPES } from './config.ts';
import type { Credentials, MonitorConfig } from './config.ts';
import { StartupFailure } from './diagnostics.ts';
import { assertRelayConfig, RADAR_BOT, SlackMetadataRelaySink, VERIFIED_RELAY, workOneRelay } from './relay.ts';
import { assertMonitoringPolicy, ingestMonitoredRelay, loadMonitoringPolicy } from './monitoring.ts';
import type { MonitoringPolicy } from './monitoring.ts';
import type { RelayConfig } from './relay.ts';
import { startMonitorRuntime } from './runtime.ts';
import type { RuntimeHandle, RuntimeStatus } from './runtime.ts';
import type { RelayRuntimeDependencies } from './relay-runtime.ts';
import { botRelayPort, SlackThreadReader, userReadPort } from './slack.ts';
import { createSocketPort } from './socket.ts';
import { SqliteQueue } from './store.ts';
import { hostedDirectories, openMacStore } from './mac-storage.ts';
import type { HostedPlatform } from './mac-storage.ts';

export const HOSTED_DATA_DIRECTORY = '/var/lib/thread-watch';
export interface HostedConfig extends MonitorConfig {
  relay: RelayConfig; continuousApproved: boolean; deploymentApproved: boolean;
  dataDirectory: string;
  monitoring: MonitoringPolicy;
  hostingPlatform: HostedPlatform;
}
export function assertHostedConfig(config: HostedConfig): void {
  assertMonitorConfig(config); assertRelayConfig(config.relay);
  assertMonitoringPolicy(config.monitoring);
  if (!config.continuousApproved || !config.deploymentApproved || config.appId !== RADAR_BOT.appId ||
      config.botUserId !== RADAR_BOT.userId || config.dataDirectory !== hostedDirectories(config.hostingPlatform).data) {
    throw new StartupFailure('configuration', 'unexpected');
  }
}
export function loadHostedConfig(env: Record<string, string | undefined>, hostingPlatform: HostedPlatform = 'linux'): HostedConfig {
  const config: HostedConfig = {
    teamId: env.RADAR_TEAM_ID ?? '', userId: env.RADAR_USER_ID ?? '', appId: env.RADAR_APP_ID ?? '',
    confirmedSeparateAppId: env.RADAR_CONFIRMED_SEPARATE_APP_ID ?? '', botUserId: env.RADAR_BOT_USER_ID ?? '',
    channelTypes: ['channel', 'group', 'im', 'mpim'],
    allowConnection: env.RADAR_ALLOW_SLACK_CONNECTION === 'approved', allowReads: env.RADAR_ALLOW_SLACK_READS === 'approved',
    continuousApproved: env.RADAR_ALLOW_CONTINUOUS === 'approved', deploymentApproved: env.RADAR_DEPLOYMENT_APPROVED === 'approved',
    dataDirectory: env.RADAR_DATA_DIRECTORY ?? '', relay: { ...VERIFIED_RELAY, allowRelay: env.RADAR_ALLOW_PRIVATE_RELAY === 'approved', channelId: env.RADAR_RELAY_CHANNEL_ID ?? '' },
    verifiedAppScopes: (env.RADAR_VERIFIED_APP_SCOPES ?? '').split(',').filter(Boolean),
    monitoring: loadMonitoringPolicy(env), hostingPlatform
  };
  assertHostedConfig(config); return config;
}
export function loadHostedCredentials(env: Record<string, string | undefined>): Credentials {
  const credentials = { appToken: env.SLACK_APP_TOKEN ?? '', userToken: env.SLACK_USER_TOKEN ?? '', botToken: env.SLACK_BOT_TOKEN ?? '' };
  assertCredentials(credentials);
  for (const key of ['SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN']) delete env[key];
  return credentials;
}
export function openHostedStore(directory: string, lockFd = 3): { queue: SqliteQueue; close(): void } {
  try {
    const dir = lstatSync(directory); const lock = lstatSync(join(directory, 'service.lock'));
    const fd = fstatSync(lockFd);
    const lease = readFileSync(`/proc/self/fdinfo/${lockFd}`, 'utf8');
    const exclusive = new RegExp(`^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+WRITE\\s+${process.pid}\\s+[0-9a-f]+:[0-9a-f]+:${fd.ino}\\s+0\\s+EOF$`, 'mi');
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid?.() ||
        !lock.isFile() || lock.isSymbolicLink() || (lock.mode & 0o077) ||
        fd.ino !== lock.ino || fd.dev !== lock.dev || fd.uid !== process.getuid?.() || !exclusive.test(lease)) throw new Error('unsafe_lock');
    // FD is inherited from the exclusive kernel flock in aws/hosted-run.py.
    // Never unlink this guard file, remove an active PID file, or open/recover
    // SQLite in a second process outside that supervisor.
    const database = join(directory, 'queue.sqlite'); const db = lstatSync(database, { throwIfNoEntry: false });
    if (db && (!db.isFile() || db.isSymbolicLink() || db.uid !== process.getuid?.() || (db.mode & 0o077))) throw new Error('unsafe_queue');
    const queue = new SqliteQueue(database); let closed = false;
    return { queue, close() { if (!closed) { closed = true; queue.close(); } } };
  } catch { throw new StartupFailure('local_storage', 'unsafe_storage'); }
}
export async function startHosted(options: {
  config: HostedConfig; credentials: Credentials; dependencies?: RelayRuntimeDependencies;
  signal?: AbortSignal; onStatus?: (status: RuntimeStatus) => void; pollMs?: number;
}): Promise<RuntimeHandle> {
  assertHostedConfig(options.config); assertCredentials(options.credentials);
  if (options.signal?.aborted) throw new StartupFailure('runtime', 'cancelled');
  const deps: RelayRuntimeDependencies = options.dependencies ?? {
    userPort: userReadPort, botPort: botRelayPort, socketPort: createSocketPort,
    store: () => options.config.hostingPlatform === 'darwin'
      ? openMacStore(options.config.dataDirectory, process.env.RADAR_MAC_PYTHON ?? '')
      : openHostedStore(options.config.dataDirectory)
  };
  const reader = new SlackThreadReader(deps.userPort(options.credentials.userToken));
  const sink = new SlackMetadataRelaySink({ config: options.config.relay, botToken: options.credentials.botToken, portFactory: deps.botPort });
  const policy = Object.freeze({ ...options.config.monitoring, watchChannelIds: Object.freeze([...options.config.monitoring.watchChannelIds]) });
  return startMonitorRuntime({ config: options.config, store: deps.store,
    socket: () => deps.socketPort(options.credentials.appToken, options.config.appId),
    async authenticate(setPhase) {
      await reader.validateIdentity(USER_SCOPES);
      if (options.signal?.aborted) throw new StartupFailure('user_auth', 'cancelled');
      setPhase('bot_auth'); await sink.validateIdentity();
    },
    route: (body, store, now) => { ingestMonitoredRelay(body, options.config, options.config.relay, policy, store as SqliteQueue, now); },
    work: (store, signal) => workOneRelay({ store, sink, signal }),
    ...(options.signal ? { signal: options.signal } : {}), ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    ...(options.pollMs ? { pollMs: options.pollMs } : {})
  });
}
export function recordStatus(status: RuntimeStatus, directory = '/run/thread-watch'): void {
  const temp = join(directory, 'status.tmp');
  writeFileSync(temp, JSON.stringify({ status, observedAt: Date.now(), pid: process.pid }), { mode: 0o600 });
  renameSync(temp, join(directory, 'status.json'));
}
