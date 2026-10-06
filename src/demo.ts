import { ingest } from './intake.ts';
import { SqliteQueue } from './store.ts';
import { workOne } from './worker.ts';
import { TARGET } from './types.ts';
const config = { ...TARGET, appId: 'ATEST123', channelTypes: ['channel', 'group', 'im', 'mpim'] };
const store = new SqliteQueue(':memory:');
const event = {
  type: 'event_callback', team_id: config.teamId, api_app_id: config.appId, event_id: 'EvDEMO123',
  authorizations: [{ team_id: config.teamId, user_id: config.userId, is_bot: false }],
  event: { type: 'message', channel_type: 'channel', channel: 'CTEST123', user: 'USYNTHETIC123', ts: '1791029813.997859', text: `<@${config.userId}> Could you review the synthetic demo report by tomorrow? Reminder: prepare the notes.` }
};
console.log('Synthetic, offline demo:', ingest(event, config, store));
await workOne({ store,
  reader: { async fetchThread() { return { messages: [], truncated: false }; } },
  sink: { async sendPrivate({ text }) { console.log(text); } },
  allowPrivateDelivery: true // Fake console sink only. No Slack client/network.
});
console.log('Duplicate:', ingest(event, config, store));
store.close();
