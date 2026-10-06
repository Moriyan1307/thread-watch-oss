import { assertConfig } from './intake.ts';
import { assertExactScopes } from './slack.ts';
import { TARGET } from './types.ts';
import type { RadarConfig } from './types.ts';
import { StartupFailure } from './diagnostics.ts';
import type { FailurePhase } from './diagnostics.ts';

export const USER_SCOPES = Object.freeze(['channels:history', 'groups:history', 'im:history', 'mpim:history']);
export const BOT_SCOPES = Object.freeze(['chat:write', 'im:write']);
export const APP_SCOPES = Object.freeze(['connections:write']);
export interface MonitorConfig extends RadarConfig {
  confirmedSeparateAppId: string;
  botUserId: string;
  allowConnection: boolean;
  allowReads: boolean;
  verifiedAppScopes: readonly string[];
}
export interface BoundedConfig extends MonitorConfig { durationMs: number; maxSummaries: number }
export interface LocalConfig extends BoundedConfig { allowPrivateDelivery: boolean }
export interface Credentials { appToken: string; userToken: string; botToken: string }
export function assertLocalConfig(config: LocalConfig): void {
  assertBoundedConfig(config);
  if (!config.allowPrivateDelivery) throw new Error('Explicit approved private DM test configuration is required');
}
export function assertBoundedConfig(config: BoundedConfig): void {
  assertMonitorConfig(config);
  if (!Number.isInteger(config.durationMs) || config.durationMs < 1_000 || config.durationMs > 3_600_000 ||
      !Number.isInteger(config.maxSummaries) || config.maxSummaries < 1 || config.maxSummaries > 20) {
    throw new Error('Explicit approved local test bounds are required');
  }
}
export function assertMonitorConfig(config: MonitorConfig): void {
  assertConfig(config);
  if (!config.allowConnection || !config.allowReads ||
      config.confirmedSeparateAppId !== config.appId || !/^U[A-Z0-9]+$/.test(config.botUserId) ||
      config.botUserId === TARGET.userId || config.channelTypes.join(',') !== 'channel,group,im,mpim') {
    throw new Error('Explicit approved local test configuration is required');
  }
  assertExactScopes(config.verifiedAppScopes, APP_SCOPES);
}
export function loadBoundedConfig(env: Record<string, string | undefined>): BoundedConfig {
  return {
    teamId: env.RADAR_TEAM_ID ?? TARGET.teamId,
    userId: env.RADAR_USER_ID ?? TARGET.userId,
    appId: env.RADAR_APP_ID ?? '',
    confirmedSeparateAppId: env.RADAR_CONFIRMED_SEPARATE_APP_ID ?? '',
    botUserId: env.RADAR_BOT_USER_ID ?? '',
    channelTypes: ['channel', 'group', 'im', 'mpim'],
    allowConnection: env.RADAR_ALLOW_SLACK_CONNECTION === 'approved',
    allowReads: env.RADAR_ALLOW_SLACK_READS === 'approved',
    verifiedAppScopes: (env.RADAR_VERIFIED_APP_SCOPES ?? '').split(',').filter(Boolean),
    durationMs: Number(env.RADAR_TEST_DURATION_MS ?? '600000'),
    maxSummaries: Number(env.RADAR_TEST_MAX_SUMMARIES ?? '1')
  };
}
export function loadLocalConfig(env: Record<string, string | undefined>): LocalConfig {
  // These variables attest an already approved action; setting them does not
  // grant permission or perform OAuth. Credentials are never read from env.
  const config: LocalConfig = {
    ...loadBoundedConfig(env), allowPrivateDelivery: env.RADAR_ALLOW_PRIVATE_DM === 'approved'
  };
  assertLocalConfig(config);
  return config;
}
export function assertCredentials(credentials: Credentials): void {
  for (const [value, phase] of [[credentials.appToken,'app_token'], [credentials.userToken,'user_token'], [credentials.botToken,'bot_token']] as const) {
    assertCredential(value, phase);
  }
}
export function assertCredential(value: string, phase: Extract<FailurePhase, 'app_token' | 'user_token' | 'bot_token'>): void {
  const prefix = { app_token: 'xapp-', user_token: 'xoxp-', bot_token: 'xoxb-' }[phase];
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length <= prefix.length || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new StartupFailure(phase, 'format');
  }
}
