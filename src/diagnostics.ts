// Diagnostics contain only fixed labels and instructions. Never render an SDK
// error, its message/cause, a token, a response body, or Slack message content.
import { OperationTimeout } from './lifecycle.ts';
export type FailurePhase = 'configuration' | 'app_token' | 'user_token' | 'bot_token' |
  'user_auth' | 'bot_auth' | 'local_storage' | 'socket' | 'runtime';
export type FailureReason = 'unexpected' | 'format' | 'cancelled' | 'private_terminal' |
  'invalid_auth' | 'token_revoked' | 'token_expired' | 'access_denied' | 'inactive' |
  'missing_scope' | 'rate_limited' | 'network' | 'wrong_workspace' | 'wrong_identity' |
  'scope_metadata_missing' | 'scopes_mismatch' | 'locked' | 'unsafe_storage' | 'wrong_app' | 'timeout';
const instructions: Record<FailurePhase, string> = {
  configuration: 'Check your nonsecret installation configuration and explicit access gates.',
  app_token: 'Paste the complete Radar app-level token starting with xapp- into the hidden prompt.',
  user_token: 'Paste your complete user OAuth token starting with xoxp- into the hidden prompt.',
  bot_token: 'Paste the complete Radar Bot User OAuth Token starting with xoxb- into the hidden prompt.',
  user_auth: 'Use your configured workspace/user token. Required user scopes: channels:history, groups:history, im:history, mpim:history.',
  bot_auth: 'Use your configured app/bot token. Required bot scopes: chat:write, im:write.',
  local_storage: 'Check the private data directory. If a runtime.lock exists, confirm the previous Radar process has stopped before removing it.',
  socket: 'Enable Socket Mode for your configured app; its app-level token must have only connections:write.',
  runtime: 'The local test stopped unexpectedly. Share only the Radar status labels for troubleshooting.'
};
const explanations: Record<FailureReason, string> = {
  unexpected: 'This step could not complete.', format: 'The token is empty or has the wrong format.',
  cancelled: 'Input or startup was cancelled.', private_terminal: 'Credential entry requires your own interactive Terminal.',
  invalid_auth: 'Slack rejected this credential.', token_revoked: 'Slack reports that this token was revoked.',
  token_expired: 'Slack reports that this token expired.', access_denied: 'Slack denied access for this step.',
  inactive: 'Slack reports an inactive account or workspace.', missing_scope: 'Slack reports a missing permission.',
  rate_limited: 'Slack temporarily rate-limited this step; wait before retrying.',
  network: 'The network request to Slack failed; check your connection.',
  wrong_workspace: 'This credential belongs to a different workspace.',
  wrong_identity: 'This credential belongs to a different user or bot.',
  scope_metadata_missing: 'Slack did not supply the permission metadata needed to verify this credential.',
  scopes_mismatch: 'This credential has missing or extra permissions compared with the approved set.',
  locked: 'A local runtime lock already exists.', unsafe_storage: 'The queue path is not a private regular directory/file.',
  wrong_app: 'The Socket Mode connection identified a different Slack app.', timeout: 'This step timed out.'
};
export class StartupFailure extends Error {
  readonly phase: FailurePhase;
  readonly reason: FailureReason;
  constructor(phase: FailurePhase, reason: FailureReason) {
    super('radar_startup_failed'); this.phase = phase; this.reason = reason;
  }
}
// Only names from fixed local catalogs can reach the terminal. Unknown scope
// values, including malformed headers, are represented by a count only.
const reportableScopes = new Set(['channels:history', 'groups:history', 'im:history', 'mpim:history', 'chat:write', 'im:write', 'connections:write']);
// Recognition for display is not permission to use or accept these scopes.
const reportableExtraScopes = new Set([...reportableScopes, 'identify', 'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'users:read', 'users:read.email', 'users.profile:read', 'search:read', 'search:read.enterprise', 'chat:write.public', 'chat:write.customize',
  'files:read', 'files:write', 'reactions:read', 'reactions:write', 'pins:read', 'pins:write', 'links:read', 'team:read', 'usergroups:read',
  'authorizations:read', 'commands', 'incoming-webhook']);
export class ScopeMismatchFailure extends StartupFailure {
  readonly missing: readonly string[];
  readonly present: readonly string[];
  readonly extraCount: number;
  readonly recognizedExtra: readonly string[];
  readonly unknownExtraCount: number;
  constructor(phase: FailurePhase, actual: readonly string[], required: readonly string[]) {
    super(phase, 'scopes_mismatch');
    const observed = new Set(actual); const expected = new Set(required);
    this.missing = [...expected].filter(scope => reportableScopes.has(scope) && !observed.has(scope)).sort();
    this.present = [...expected].filter(scope => reportableScopes.has(scope) && observed.has(scope)).sort();
    const extra = [...observed].filter(scope => !expected.has(scope));
    this.extraCount = extra.length;
    this.recognizedExtra = extra.filter(scope => reportableExtraScopes.has(scope)).sort();
    this.unknownExtraCount = extra.length - this.recognizedExtra.length;
  }
}
export function startupFailure(error: unknown, phase: FailurePhase, fallback: FailureReason = 'unexpected'): StartupFailure {
  if (error instanceof StartupFailure) return error;
  if (error instanceof OperationTimeout) return new StartupFailure(phase, 'timeout');
  // Only recognized API/SDK identifiers influence the fixed diagnostic. No
  // string from a remote response is inserted into the resulting output.
  const e = error as { code?: unknown; data?: { error?: unknown } } | null;
  if (e?.code === 'slack_webapi_request_error' || e?.code === 'slack_webapi_http_error') return new StartupFailure(phase, 'network');
  if (e?.code === 'slack_webapi_rate_limited_error') return new StartupFailure(phase, 'rate_limited');
  if (e?.code === 'slack_webapi_platform_error') {
    switch (e.data?.error) {
      case 'not_authed': case 'invalid_auth': case 'not_allowed_token_type': return new StartupFailure(phase, 'invalid_auth');
      case 'token_revoked': return new StartupFailure(phase, 'token_revoked');
      case 'token_expired': return new StartupFailure(phase, 'token_expired');
      case 'missing_scope': return new StartupFailure(phase, 'missing_scope');
      case 'ratelimited': return new StartupFailure(phase, 'rate_limited');
      case 'account_inactive': case 'team_disabled': case 'user_removed_from_team': return new StartupFailure(phase, 'inactive');
      case 'access_denied': case 'no_permission': case 'accesslimited': case 'team_access_not_granted': return new StartupFailure(phase, 'access_denied');
    }
  }
  return new StartupFailure(phase, fallback);
}
export function formatStartupFailure(error: unknown, phase: FailurePhase): string {
  const failure = startupFailure(error, phase);
  const scopes = failure instanceof ScopeMismatchFailure ?
    `\nRadar scopes: present approved: ${failure.present.join(', ') || 'none'}\nRadar scopes: missing approved: ${failure.missing.join(', ') || 'none'}\nRadar scopes: extra permissions: ${failure.extraCount}\nRadar scopes: recognized extra names: ${failure.recognizedExtra.join(', ') || 'none'}\nRadar scopes: unknown extra names withheld: ${failure.unknownExtraCount}` : '';
  return `Radar: failed [${failure.phase}/${failure.reason}]\n${explanations[failure.reason]}${scopes}\n${instructions[failure.phase]}`;
}
