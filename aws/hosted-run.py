#!/usr/bin/env python3
"""Acquire the process-lifetime kernel lease, then exec the secret wrapper."""
import fcntl
import os
import stat
import sys
from pathlib import Path

DATA_DIRECTORY = Path('/var/lib/thread-watch')

def acquire_lock(directory: Path) -> int:
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('unsafe_directory')
    fd = os.open(directory / 'service.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('unsafe_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if fd != 3:
            os.dup2(fd, 3, inheritable=True)
            os.close(fd)
        else:
            os.set_inheritable(3, True)
        return 3
    except BaseException:
        os.close(fd)
        raise

def main() -> int:
    if sys.platform != 'linux':
        print('Radar hosted: Linux supervisor required.', file=sys.stderr)
        return 78
    try:
        acquire_lock(DATA_DIRECTORY)
        os.execv('/usr/bin/python3', ['/usr/bin/python3', '/opt/thread-watch/aws/asm-exec.py'])
    except BlockingIOError:
        print('Radar hosted: worker lease already held.', file=sys.stderr)
        return 75
    except Exception:
        print('Radar hosted: supervisor failed.', file=sys.stderr)
        return 78

if __name__ == '__main__':
    sys.exit(main())
