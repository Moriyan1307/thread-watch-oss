import { fileURLToPath } from 'node:url';
import { assertBoundedConfig, assertCredentials, loadBoundedConfig, USER_SCOPES } from './config.ts';
import type { BoundedConfig, Credentials } from './config.ts';
import { openLocalStore } from './local-store.ts';
import { assertRelayConfig, ingestRelay, RADAR_BOT, SlackMetadataRelaySink, VERIFIED_RELAY, workOneRelay } from './relay.ts';
import type { RelayConfig } from './relay.ts';
import { startBoundedRuntime } from './runtime.ts';
import type { RuntimeDependencies, RuntimeHandle, RuntimeStatus } from './runtime.ts';
import { botRelayPort, SlackThreadReader, userReadPort } from './slack.ts';
import type { SlackRelayPort } from './slack.ts';
import { createSocketPort } from './socket.ts';

export interface RelayTestConfig extends BoundedConfig { relay: RelayConfig }
export interface RelayRuntimeDependencies extends Omit<RuntimeDependencies, 'botPort'> { botPort(token: string): SlackRelayPort }
export function assertRelayTestConfig(config: RelayTestConfig): void {
  assertBoundedConfig(config); assertRelayConfig(config.relay);
  if (config.appId !== RADAR_BOT.appId || config.botUserId !== RADAR_BOT.userId ||
      config.durationMs > 600_000 || config.maxSummaries !== 1) throw new Error('radar_relay_test_configuration_required');
}
export function loadRelayTestConfig(env: Record<string, string | undefined>): RelayTestConfig {
  if (env.RADAR_ALLOW_PRIVATE_RELAY !== 'approved' || env.RADAR_RELAY_CHANNEL_ID !== VERIFIED_RELAY.channelId) {
    throw new Error('radar_relay_test_configuration_required');
  }
  const config = { ...loadBoundedConfig(env), relay: VERIFIED_RELAY };
  assertRelayTestConfig(config);
  return config;
}
const defaults: RelayRuntimeDependencies = {
  userPort: userReadPort, botPort: botRelayPort, socketPort: createSocketPort,
  // Separate from existing DM jobs; all persisted mentions have empty text.
  store: () => openLocalStore(fileURLToPath(new URL('../data-relay/', import.meta.url)))
};
export async function startRelayTest(options: {
  config: RelayTestConfig; credentials: Credentials; dependencies?: RelayRuntimeDependencies;
  signal?: AbortSignal; onStatus?: (status: RuntimeStatus) => void; pollMs?: number;
}): Promise<RuntimeHandle> {
  assertRelayTestConfig(options.config); assertCredentials(options.credentials);
  if (options.signal?.aborted) throw new Error('radar_relay_test_cancelled');
  const deps = options.dependencies ?? defaults;
  const reader = new SlackThreadReader(deps.userPort(options.credentials.userToken));
  const sink = new SlackMetadataRelaySink({ config: options.config.relay, botToken: options.credentials.botToken, portFactory: deps.botPort });
  return startBoundedRuntime({ ...options, store: deps.store,
    socket: () => deps.socketPort(options.credentials.appToken, options.config.appId),
    async authenticate(setPhase) {
      // Authenticate the user without fetching any source/thread. The native
      // processor automation owns original-source access and research.
      await reader.validateIdentity(USER_SCOPES);
      if (options.signal?.aborted) throw new Error('radar_relay_test_cancelled');
      setPhase('bot_auth'); await sink.validateIdentity();
    },
    route: (body, store, now) => { ingestRelay(body, options.config, options.config.relay, store, now); },
    work: (store, signal) => workOneRelay({ store, sink, signal })
  });
}
