import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingest } from '../src/intake.ts';
import { SqliteQueue } from '../src/store.ts';
import { workOne } from '../src/worker.ts';
import { classify } from '../src/triage.ts';
import { RetryLater } from '../src/types.ts';
import { config, envelope } from './helpers.ts';

test('local categories and possible deadline are explicit heuristic results', () => {
  const result = classify('URGENT: could you review this? Reminder: send it by tomorrow');
  assert.deepEqual(result.categories, ['attention', 'question', 'task', 'reminder']);
  assert.equal(result.urgency, 'high');
  assert.equal(result.deadlineText, 'by tomorrow');
  assert.equal(result.method, 'local-rules');
});
test('only matches fetch context, and default delivery/research are disabled', async () => {
  const store = new SqliteQueue(':memory:'); let reads = 0; let sends = 0;
  const options = { store, clock: () => 0, reader: { async fetchThread() { reads++; return { messages: [], truncated: false }; } }, sink: { async sendPrivate() { sends++; } } };
  try {
    ingest(envelope('No mention'), config, store, 0);
    assert.equal(await workOne(options), 'idle'); assert.equal(reads, 0);
    ingest(envelope(), config, store, 0);
    assert.equal(await workOne(options), 'prepared'); assert.equal(reads, 1); assert.equal(sends, 0);
  } finally { store.close(); }
});
test('successful private summary is delivered only to the fixed user; text is erased, dedupe remains', async () => {
  const store = new SqliteQueue(':memory:'); let text = ''; let recipient = '';
  try {
    ingest(envelope(), config, store, 0);
    assert.equal(await workOne({ store, clock: () => 0, allowPrivateDelivery: true,
      reader: { async fetchThread() { return { messages: [], truncated: true }; } },
      sink: { async sendPrivate(input) { text = input.text; recipient = input.recipientId; } }
    }), 'sent');
    assert.equal(recipient, config.userId); assert.match(text, /local rules/); assert.match(text, /Research: disabled/);
    assert.equal(text.includes(`<@${config.userId}>`), false);
    assert.equal(store.status('EvTEST123'), 'done');
    assert.equal(ingest(envelope(), config, store, 100), 'duplicate');
  } finally { store.close(); }
});
test('external provider cannot receive private content without its specific approval', async () => {
  const store = new SqliteQueue(':memory:'); let calls = 0;
  try {
    ingest(envelope(), config, store, 0);
    const result = await workOne({ store, clock: () => 0,
      reader: { async fetchThread() { return { messages: [], truncated: false }; } }, sink: { async sendPrivate() { assert.fail(); } },
      provider: { id: 'unchosen-provider', external: true, async research() { calls++; return { status: 'completed' }; } }, approvedExternalProviderId: 'different-provider'
    });
    assert.equal(result, 'retry'); assert.equal(calls, 0);
  } finally { store.close(); }
});
test('read failures back off and stop at the maximum attempt count', async () => {
  const store = new SqliteQueue(':memory:'); let now = 0;
  const options = { store, clock: () => now, maxAttempts: 2, reader: { async fetchThread(): Promise<never> { throw new Error('synthetic failure'); } }, sink: { async sendPrivate() { assert.fail(); } } };
  try {
    ingest(envelope(), config, store, now);
    assert.equal(await workOne(options), 'retry');
    assert.equal(await workOne(options), 'idle');
    now = 60_000; assert.equal(await workOne(options), 'retry');
    assert.equal(store.status('EvTEST123'), 'dead');
  } finally { store.close(); }
});
test('definite rate-limited send retries using saved result without refetching context', async () => {
  const store = new SqliteQueue(':memory:'); let now = 0; let sends = 0; let reads = 0;
  const options = { store, clock: () => now, allowPrivateDelivery: true,
    reader: { async fetchThread() { reads++; return { messages: [], truncated: false }; } },
    sink: { async sendPrivate() { if (++sends === 1) throw new RetryLater(120_000); } }
  };
  try {
    ingest(envelope(), config, store, now);
    assert.equal(await workOne(options), 'retry'); now = 119_000;
    assert.equal(await workOne(options), 'idle'); now = 120_000;
    assert.equal(await workOne(options), 'sent'); assert.equal(reads, 1); assert.equal(sends, 2);
  } finally { store.close(); }
});
test('ambiguous send error quarantines delivery, preventing automatic duplicate DMs', async () => {
  const store = new SqliteQueue(':memory:');
  try {
    ingest(envelope(), config, store, 0);
    assert.equal(await workOne({ store, clock: () => 0, allowPrivateDelivery: true,
      reader: { async fetchThread() { return { messages: [], truncated: false }; } },
      sink: { async sendPrivate() { throw new Error('Timeout after possible send'); } }
    }), 'uncertain');
    assert.equal(store.claim(1_000_000), undefined);
  } finally { store.close(); }
});
test('SQLite survives restart, recovers interrupted work, quarantines interrupted sends, and enforces file permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-test-')); const path = join(dir, 'queue.sqlite');
  let store = new SqliteQueue(path);
  try {
    ingest(envelope(), config, store, 0); store.claim(0); store.close();
    store = new SqliteQueue(path); assert.equal(store.claim(0)?.attempts, 2);
    store.beginSending('EvTEST123'); store.close();
    store = new SqliteQueue(path); assert.equal(store.status('EvTEST123'), 'uncertain');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(store.prune(8 * 24 * 60 * 60 * 1000), 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
