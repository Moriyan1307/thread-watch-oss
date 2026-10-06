import { TARGET } from '../src/types.ts';
export const config = { ...TARGET, appId: 'ATEST123', channelTypes: ['channel', 'group', 'im', 'mpim'] };
export function envelope(text = `<@${config.userId}> Could you review the proposal by tomorrow?`, overrides: Record<string, unknown> = {}) {
  return {
    type: 'event_callback', team_id: config.teamId, api_app_id: config.appId, event_id: 'EvTEST123',
    authorizations: [{ team_id: config.teamId, user_id: config.userId, is_bot: false }],
    event: { type: 'message', channel_type: 'channel', channel: 'CTEST123', user: 'USENDER123', ts: '1791029813.997859', text },
    ...overrides
  };
}
