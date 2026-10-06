"""Kernel lease shared by the supervisor, Node worker and lease verifier."""
import fcntl
import os
import stat
from pathlib import Path

def private_directory(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('unsafe_directory')

def acquire_lock(directory: Path) -> int:
    private_directory(directory)
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

def verify_lock(directory: Path, fd: int = 3) -> None:
    private_directory(directory)
    guard = directory / 'service.lock'
    disk = guard.lstat(); inherited = os.fstat(fd)
    if not stat.S_ISREG(disk.st_mode) or disk.st_uid != os.getuid() or disk.st_mode & 0o077 or \
            (disk.st_dev, disk.st_ino) != (inherited.st_dev, inherited.st_ino):
        raise ValueError('unsafe_lock')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    other = os.open(guard, os.O_RDWR | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        raise ValueError('lease_not_exclusive')
    finally:
        os.close(other)

def lease_available(directory: Path) -> bool:
    private_directory(directory)
    try: fd = os.open(directory / 'service.lock', os.O_RDWR | os.O_NOFOLLOW)
    except FileNotFoundError: return True
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('unsafe_lock')
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); return True
        except BlockingIOError: return False
    finally: os.close(fd)
