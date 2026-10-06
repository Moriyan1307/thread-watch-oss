import { App, HTTPReceiver, LogLevel } from '@slack/bolt';
import type { Logger } from '@slack/bolt';
import { assertConfig, ingest } from './intake.ts';
import type { QueueStore, RadarConfig } from './types.ts';

// Silence SDK logs: neither credentials nor Slack bodies may go to console/logs.
// A hosted runtime should add metrics with constant labels, not raw SDK errors.
export const quietLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  setLevel() {}, getLevel() { return LogLevel.ERROR; }, setName() {}
};
export function createBoltIngress(options: {
  config: RadarConfig; store: QueueStore; signingSecret: string; userToken: string;
}): { app: App; receiver: HTTPReceiver } {
  assertConfig(options.config);
  if (!options.signingSecret || !options.userToken) throw new Error('Credentials must be supplied securely in memory');
  const receiver = new HTTPReceiver({
    signingSecret: options.signingSecret,
    signatureVerification: true,
    processBeforeResponse: true,
    bodyLimit: 256 * 1024,
    logger: quietLogger,
    // Persistence failure must produce a failed delivery so Slack retries it.
    async processEventErrorHandler({ response }) {
      if (!response.headersSent) response.writeHead(503);
      response.end();
      return false;
    }
  });
  const app = new App({
    receiver, logger: quietLogger, developerMode: false,
    ignoreSelf: false, tokenVerificationEnabled: false,
    // Construction never calls Slack. Before live use, validate token identity
    // separately using the read adapter, restricted to the one approved installer.
    authorize: async () => ({ userToken: options.userToken, userId: options.config.userId, teamId: options.config.teamId })
  });
  app.error(async () => { throw new Error('radar_ingress_failed'); });
  app.use(async ({ body }) => {
    // HTTPReceiver verifies HMAC/timestamp and handles URL challenges. Bolt's
    // ack is held until this synchronous durable enqueue finishes. Worker work
    // (context, research, DM) never runs in the event listener.
    ingest(body, options.config, options.store);
  });
  return { app, receiver };
}
