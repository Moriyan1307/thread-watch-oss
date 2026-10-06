import { fstatSync, lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { StartupFailure } from './diagnostics.ts';
import { SqliteQueue } from './store.ts';

export type HostedPlatform = 'linux' | 'darwin';
export function hostedDirectories(platform: HostedPlatform) {
  if (platform === 'linux') return { data: '/var/lib/thread-watch', run: '/run/thread-watch' };
  if (platform !== 'darwin') throw new StartupFailure('configuration', 'unexpected');
  const base = join(userInfo().homedir, 'Library', 'Application Support', 'thread-watch');
  return { data: join(base, 'data'), run: join(base, 'run') };
}
export function assertPrivateDirectory(directory: string): void {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new StartupFailure('local_storage', 'unsafe_storage');
  }
}
export function openMacStore(directory: string, python: string, lockFd = 3) {
  try {
    if (process.platform !== 'darwin' || !isAbsolute(python)) throw new Error('platform');
    assertPrivateDirectory(directory);
    const lock = lstatSync(join(directory, 'service.lock')); const fd = fstatSync(lockFd);
    if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== process.getuid?.() ||
        (lock.mode & 0o077) || fd.ino !== lock.ino || fd.dev !== lock.dev) throw new Error('lease');
    // Python verifies/acquires the same inherited open-file-description lease,
    // and proves that a separately opened guard cannot take it. FD 3 remains
    // held in Node after the verifier exits, before any SQLite recovery.
    const verifier = fileURLToPath(new URL('../mac/verify-lease.py', import.meta.url));
    const checked = spawnSync(python, [verifier, directory], {
      stdio: ['ignore', 'ignore', 'ignore', lockFd], timeout: 5000
    });
    if (checked.status !== 0) throw new Error('lease');
    const database = join(directory, 'queue.sqlite');
    const info = lstatSync(database, { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new Error('queue');
    const queue = new SqliteQueue(database); let closed = false;
    return { queue, close() { if (!closed) { closed = true; queue.close(); } } };
  } catch { throw new StartupFailure('local_storage', 'unsafe_storage'); }
}
