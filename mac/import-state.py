"""Owner-only opaque queue import. Agents never invoke this on private state."""
import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from common import BASE, DATA, installation, write_private
from lease import acquire_lock

def import_state(source: Path, destination: Path) -> dict:
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size == 0:
        raise ValueError('private_source_required')
    if destination.exists() or destination.is_symlink(): raise ValueError('existing_state')
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    temp = destination.with_name('queue.importing')
    digest = hashlib.sha256(); count = 0
    try:
        with os.fdopen(fd, 'rb') as original, temp.open('xb') as output:
            temp.chmod(0o600)
            while chunk := original.read(65536):
                digest.update(chunk); output.write(chunk); count += len(chunk)
            output.flush(); os.fsync(output.fileno())
        if count != info.st_size: raise ValueError('source_changed')
        os.replace(temp, destination)
        return {'version': 1, 'bytes': count, 'sha256': digest.hexdigest()}
    finally:
        if temp.exists(): temp.unlink()

def main():
    fd = None
    try:
        if sys.platform != 'darwin' or len(sys.argv) != 2 or not sys.stdin.isatty() or not sys.stdout.isatty():
            raise ValueError('owner_terminal')
        installation()
        if (BASE / 'activation.json').exists(): raise ValueError('active')
        fd = acquire_lock(DATA)
        result = import_state(Path(sys.argv[1]), DATA / 'queue.sqlite')
        write_private(BASE / 'import.json', json.dumps(result).encode())
        print('Thread Watch state: imported without displaying contents. Worker remains inactive.')
        return 0
    except (Exception, KeyboardInterrupt):
        print('Thread Watch state: import refused. Check private file permissions and stopped workers.'); return 78
    finally:
        if fd is not None: os.close(fd)

if __name__ == '__main__': sys.exit(main())
