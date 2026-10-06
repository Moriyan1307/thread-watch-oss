import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentifiedClient, SocketIngress } from '../src/socket.ts';
import type { SocketDelivery, SocketHandlers, SocketPort } from '../src/socket.ts';
import { SqliteQueue } from '../src/store.ts';
import { config, envelope } from './helpers.ts';

export class FakeSocket implements SocketPort {
  handlers?: SocketHandlers; connects = 0; disconnects = 0;
  setHandlers(value: SocketHandlers) { this.handlers = value; }
  async connect() { this.connects++; }
  async disconnect() { this.disconnects++; this.handlers?.disconnected(); }
  emit(body: unknown, ack: () => Promise<void>, type = 'events_api') { this.handlers?.envelope({ type, body, ack }); }
}
test('Socket Mode persists matches before ack, dedupes retries, and acknowledges ignored messages without retaining them', async () => {
  const store = new SqliteQueue(':memory:'); const port = new FakeSocket(); let acknowledgments = 0;
  const ingress = new SocketIngress({ config, store, port, clock: () => 0 });
  try {
    await ingress.connect();
    const ack = async () => { assert.equal(store.status('EvTEST123'), 'pending'); acknowledgments++; };
    port.emit(envelope(), ack); await ingress.settled();
    port.emit(envelope(), ack); await ingress.settled();
    port.emit(envelope('No mention', { event_id: 'EvIGNORED' }), async () => { acknowledgments++; }); await ingress.settled();
    assert.equal(acknowledgments, 3); assert.equal(store.status('EvIGNORED'), undefined);
    assert.ok(store.claim(0)); assert.equal(store.claim(0), undefined);
    await ingress.stop(); port.emit(envelope(), async () => { assert.fail('No ack after stop'); }); await ingress.settled();
  } finally { store.close(); }
});
test('Socket Mode queue failure never acknowledges lost work and reports only a constant status', async () => {
  const port = new FakeSocket(); const statuses: string[] = []; let fatal = 0;
  const store = { enqueue(): never { throw new Error('synthetic-secret-bearing-storage-error'); }, claim() { return undefined; }, savePrepared() {}, complete() {}, retry() {} };
  const ingress = new SocketIngress({ config, store, port, onStatus: s => statuses.push(s), onFatal: () => { fatal++; } });
  await ingress.connect(); port.emit(envelope(), async () => { assert.fail('Storage failed'); }); await ingress.settled();
  assert.deepEqual(statuses, ['queue_failed']); assert.equal(fatal, 1); await ingress.stop();
});
test('failed Socket ack retains saved work and a later retry is deduped', async () => {
  const store = new SqliteQueue(':memory:'); const port = new FakeSocket(); const statuses: string[] = [];
  const ingress = new SocketIngress({ config, store, port, clock: () => 0, onStatus: s => statuses.push(s) });
  try {
    await ingress.connect(); port.emit(envelope(), async () => { throw new Error('synthetic secret'); }); await ingress.settled();
    assert.equal(store.status('EvTEST123'), 'pending'); assert.deepEqual(statuses, ['ack_failed']);
    port.emit(envelope(), async () => {}); await ingress.settled();
    assert.ok(store.claim(0)); assert.equal(store.claim(0), undefined); await ingress.stop();
  } finally { store.close(); }
});
test('actual SDK decoder rejects a wrong-app hello before connected/event dispatch and accepts only the expected app', async () => {
  class Harness extends IdentifiedClient {
    stops = 0;
    constructor() { super('xapp-public-synthetic', config.appId, new AbortController().signal); }
    async disconnect() { this.stops++; }
    async deliver(body: unknown) { await this.onWebSocketMessage(JSON.stringify(body), false); }
  }
  const invalid = new Harness(); let connected = 0; let fatal = 0;
  invalid.on('connected', () => connected++); invalid.on('radar_identity_failed', () => fatal++);
  await invalid.deliver({ type: 'hello', connection_info: { app_id: 'AOTHER' } });
  assert.equal(connected, 0); assert.equal(fatal, 1); assert.equal(invalid.stops, 1);
  const valid = new Harness(); let received: SocketDelivery | undefined;
  valid.on('connected', () => connected++); valid.on('slack_event', (d: SocketDelivery) => { received = d; });
  await valid.deliver({ type: 'hello', connection_info: { app_id: config.appId } });
  await valid.deliver({ type: 'events_api', envelope_id: 'public-synthetic-envelope', payload: envelope() });
  assert.equal(connected, 1); assert.deepEqual(received?.body, envelope()); assert.equal(received?.type, 'events_api');
});
