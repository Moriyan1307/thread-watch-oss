import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HTTPReceiver } from '@slack/bolt';
import { createBoltIngress } from '../src/bolt.ts';
import { SqliteQueue } from '../src/store.ts';
import { config, envelope } from './helpers.ts';

// Public synthetic values, never real Slack credentials. In-memory request/response
// streams exercise the real Bolt verifier without listening on a port or networking.
const syntheticSecret = 'public-synthetic-test-signing-key';
function request(receiver: HTTPReceiver, body: unknown, options: { badSignature?: boolean; old?: boolean; retry?: boolean } = {}): Promise<{ status: number; text: string }> {
  const data = JSON.stringify(body);
  const timestamp = Math.floor(Date.now()/1000) - (options.old ? 600 : 0);
  const digest = createHmac('sha256',syntheticSecret).update(`v0:${timestamp}:${data}`).digest('hex');
  const req = Object.assign(Readable.from([Buffer.from(data)]), {
    method:'POST', url:'/slack/events',
    headers: { 'content-type':'application/json', 'content-length':String(Buffer.byteLength(data)), 'x-slack-request-timestamp':String(timestamp), 'x-slack-signature':`v0=${options.badSignature ? '0'.repeat(64) : digest}`, ...(options.retry ? { 'x-slack-retry-num':'1', 'x-slack-retry-reason':'http_timeout' } : {}) }
  });
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic request timed out')), 3500);
    const res = {
      statusCode:200, headersSent:false,
      writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
      setHeader() { return this; },
      end(text = '') { clearTimeout(timer); resolve({status:this.statusCode,text:String(text)}); }
    };
    receiver.requestListener(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}
test('Bolt validates HMAC and timestamp, and accepts signed URL verification', async () => {
  const store = new SqliteQueue(':memory:');
  const { receiver } = createBoltIngress({config,store,signingSecret:syntheticSecret,userToken:'synthetic-inert-token'});
  try {
    assert.equal((await request(receiver,envelope(),{badSignature:true})).status,401);
    assert.equal((await request(receiver,envelope(),{old:true})).status,401);
    assert.equal(store.claim(Date.now()),undefined);
    const challenge = await request(receiver,{type:'url_verification',challenge:'synthetic-challenge'});
    assert.equal(challenge.status,200); assert.match(challenge.text,/synthetic-challenge/);
  } finally { store.close(); }
});
test('Bolt persists a signed event before 200 acknowledgement and accepts retry without duplicate work', async () => {
  const store = new SqliteQueue(':memory:');
  const { receiver } = createBoltIngress({config,store,signingSecret:syntheticSecret,userToken:'synthetic-inert-token'});
  try {
    const start = performance.now();
    assert.equal((await request(receiver,envelope())).status,200);
    assert.ok(performance.now()-start < 3000);
    assert.equal(store.status('EvTEST123'),'pending');
    assert.equal((await request(receiver,envelope(),{retry:true})).status,200);
    assert.ok(store.claim(Date.now())); assert.equal(store.claim(Date.now()),undefined);
  } finally { store.close(); }
});
test('queue failure returns 503 instead of acknowledging lost work', async () => {
  const store = {
    enqueue(): never { throw new Error('Synthetic storage failure'); },
    claim() { return undefined; }, savePrepared() {}, complete() {}, retry() {}
  };
  const { receiver } = createBoltIngress({config,store,signingSecret:syntheticSecret,userToken:'synthetic-inert-token'});
  assert.equal((await request(receiver,envelope())).status,503);
});
