import { closeSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteQueue } from './store.ts';
import { StartupFailure } from './diagnostics.ts';

export function openLocalStore(directory: string): { queue: SqliteQueue; close(): void } {
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077))) {
    throw new StartupFailure('local_storage', 'unsafe_storage');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = join(directory, 'queue.sqlite');
  const databaseStat = lstatSync(database, { throwIfNoEntry: false });
  if (databaseStat && (!databaseStat.isFile() || databaseStat.isSymbolicLink())) throw new StartupFailure('local_storage', 'unsafe_storage');
  const lock = join(directory, 'runtime.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch (error) {
    throw new StartupFailure('local_storage', (error as { code?: unknown })?.code === 'EEXIST' ? 'locked' : 'unexpected');
  }
  try { writeFileSync(fd, String(process.pid)); }
  catch { unlinkSync(lock); throw new Error('Local lock initialization failed'); }
  finally { closeSync(fd); }
  let queue: SqliteQueue;
  try { queue = new SqliteQueue(database); }
  catch { unlinkSync(lock); throw new Error('Local queue initialization failed'); }
  let closed = false;
  return { queue, close() {
    if (closed) return;
    closed = true;
    try { queue.close(); } finally { unlinkSync(lock); }
  } };
}
