import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Job, Mention, PreparedResult, QueueStore } from './types.ts';

// Single-worker store used by bounded local tests and hosted encrypted EBS.
// Hosted intake persists references only, never source text or fetched threads.
export class SqliteQueue implements QueueStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA secure_delete=ON;
      PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, message_key TEXT NOT NULL UNIQUE,
        mention TEXT NOT NULL, prepared TEXT,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS followed_threads (
        team_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(team_id, channel_id, thread_ts)
      );
    `);
    // A process restart recovers work interrupted before delivery. Sending has an
    // ambiguous external outcome and must be reviewed rather than automatically sent.
    this.db.exec("UPDATE jobs SET status='pending' WHERE status='processing'; UPDATE jobs SET status='uncertain' WHERE status='sending'");
  }
  enqueue(mention: Mention, now: number): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO jobs(id,message_key,mention,available_at,created_at) VALUES(?,?,?,?,?)')
      .run(mention.eventId, mention.messageKey, JSON.stringify(mention), now, now).changes === 1;
  }
  followsThread(teamId: string, channelId: string, threadTs: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM followed_threads WHERE team_id=? AND channel_id=? AND thread_ts=?').get(teamId, channelId, threadTs);
  }
  enqueueMonitored(mention: Mention, now: number, followThread: boolean): boolean {
    // Persist follow state and its reference job atomically before Slack ack.
    // Tracking retains IDs only, independently of the 24-hour job/dedupe expiry.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (followThread) this.db.prepare('INSERT OR IGNORE INTO followed_threads(team_id,channel_id,thread_ts,created_at) VALUES(?,?,?,?)')
        .run(mention.teamId, mention.channelId, mention.threadTs, now);
      const queued = this.enqueue({ ...mention, text: '' }, now);
      this.db.exec('COMMIT'); return queued;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  claim(now: number): Job | undefined {
    const row = this.db.prepare("UPDATE jobs SET status='processing', attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE status='pending' AND available_at<=? ORDER BY created_at LIMIT 1) RETURNING id,mention,attempts,prepared").get(now);
    if (!row) return;
    return { id: String(row.id), mention: JSON.parse(String(row.mention)), attempts: Number(row.attempts), ...(row.prepared ? { prepared: JSON.parse(String(row.prepared)) } : {}) };
  }
  savePrepared(id: string, prepared: PreparedResult): void {
    this.db.prepare("UPDATE jobs SET prepared=? WHERE id=? AND status='processing'").run(JSON.stringify(prepared), id);
  }
  beginSending(id: string): void {
    this.db.prepare("UPDATE jobs SET status='sending' WHERE id=? AND status='processing'").run(id);
  }
  markUncertain(id: string): void {
    this.db.prepare("UPDATE jobs SET status='uncertain' WHERE id=?").run(id);
  }
  complete(id: string, now: number): void {
    // Keep only dedupe keys on successful delivery; discard retained message text.
    this.db.prepare("UPDATE jobs SET status='done', mention='{}', prepared=NULL,finished_at=? WHERE id=?").run(now, id);
  }
  retry(id: string, availableAt: number, maxAttempts: number): void {
    this.db.prepare("UPDATE jobs SET status=CASE WHEN attempts>=? THEN 'dead' ELSE 'pending' END,available_at=? WHERE id=?").run(maxAttempts, availableAt, id);
  }
  prune(now: number, retentionMs = 7 * 24 * 60 * 60 * 1000): number {
    // Dead/uncertain payloads expire too. Pending jobs are left for the operator.
    return Number(this.db.prepare("DELETE FROM jobs WHERE status IN ('done','dead','uncertain') AND created_at<?").run(now - retentionMs).changes);
  }
  expire(now: number, retentionMs: number): number {
    // Runtime retention bounds pending/prepared payloads too. Active work is
    // left alone until completion/retry. Removing records ends their dedupe.
    return Number(this.db.prepare("DELETE FROM jobs WHERE status NOT IN ('processing','sending') AND created_at<?").run(now - retentionMs).changes);
  }
  status(id: string): string | undefined {
    return this.db.prepare('SELECT status FROM jobs WHERE id=?').get(id)?.status as string | undefined;
  }
  close(): void { this.db.close(); }
}
