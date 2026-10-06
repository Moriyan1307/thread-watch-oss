"""Owner-only CloudShell download through an existing local SSM port forward."""
import getpass
import hashlib
import os
import re
import sys
import urllib.request
from pathlib import Path

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): raise ValueError('redirect')

def download(password: str, destination: Path, opener=None):
    if destination.exists() or destination.is_symlink(): raise ValueError('existing_file')
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request('http://127.0.0.1:18765/queue.sqlite', headers={'X-State-Key': password})
    temp = destination.with_name(destination.name + '.part')
    try:
        with opener.open(request, timeout=30) as response:
            expected = response.headers['X-State-SHA256']; size = int(response.headers['Content-Length'])
            if not re.fullmatch('[0-9a-f]{64}', expected) or not 0 < size <= 2**30: raise ValueError('metadata')
            count = 0; digest = hashlib.sha256()
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output:
                while chunk := response.read(65536):
                    count += len(chunk)
                    if count > size: raise ValueError('size')
                    digest.update(chunk); output.write(chunk)
                output.flush(); os.fsync(output.fileno())
            if count != size or digest.hexdigest() != expected: raise ValueError('checksum')
        os.replace(temp, destination)
    finally:
        if temp.exists(): temp.unlink()

def main():
    try:
        if not sys.stdin.isatty() or not sys.stdout.isatty(): raise ValueError('owner_terminal')
        password = getpass.getpass('Same one-time transfer password (hidden): ')
        if not re.fullmatch('[A-Za-z0-9_-]{24,256}', password): raise ValueError('password')
        download(password, Path.cwd() / 'thread-watch-queue.sqlite')
        print('Thread Watch state: downloaded and checksum verified. Use CloudShell Actions > Download file privately.'); return 0
    except (Exception, KeyboardInterrupt):
        print('Thread Watch state: download incomplete. No contents or transfer password displayed.'); return 78

if __name__ == '__main__': sys.exit(main())
