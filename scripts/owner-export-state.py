"""Owner-only AWS queue export over an authenticated loopback SSM tunnel.

Never run this live through agent tools. Run as radar in an owner-private SSM
Terminal after disabling/stopping the service. No credentials or queue content
are printed. The temporary transfer password is entered with echo disabled.
"""
import fcntl
import getpass
import hashlib
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DATA = Path('/var/lib/thread-watch')

def stopped_service():
    for name, value in [('ActiveState', 'inactive'), ('MainPID', '0'), ('UnitFileState', 'disabled')]:
        checked = subprocess.run(['/usr/bin/systemctl', 'show', 'thread-watch.service', '--property=' + name, '--value'],
            check=True, capture_output=True, text=True)
        if checked.stdout.strip() != value: raise ValueError('worker_not_stopped_disabled')

def freeze(directory: Path):
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077: raise ValueError('directory')
    fd = os.open(directory / 'service.lock', os.O_RDWR | os.O_NOFOLLOW)
    try:
        lock = os.fstat(fd)
        if not stat.S_ISREG(lock.st_mode) or lock.st_uid != os.getuid() or lock.st_mode & 0o077: raise ValueError('lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        database = directory / 'queue.sqlite'; info = database.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size == 0: raise ValueError('queue')
        for suffix in ('-journal', '-wal'):
            if (directory / ('queue.sqlite' + suffix)).exists(): raise ValueError('unclean_shutdown')
        return fd, database
    except BaseException:
        os.close(fd); raise

def handler_for(database: Path, password: str):
    class Handler(BaseHTTPRequestHandler):
        completed = False
        def setup(self):
            super().setup(); self.connection.settimeout(30)
        def log_message(self, *args): pass
        def do_GET(self):
            supplied = self.headers.get('X-State-Key', '')
            if self.path != '/queue.sqlite' or not supplied.isascii() or not secrets.compare_digest(supplied, password):
                self.send_error(403); return
            with database.open('rb') as stream:
                digest = hashlib.sha256()
                while chunk := stream.read(65536): digest.update(chunk)
                stream.seek(0)
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(os.fstat(stream.fileno()).st_size))
                self.send_header('X-State-SHA256', digest.hexdigest()); self.end_headers()
                shutil.copyfileobj(stream, self.wfile)
                type(self).completed = True
    return Handler

def main():
    fd = None
    try:
        if sys.platform != 'linux' or not sys.stdin.isatty() or not sys.stdout.isatty(): raise ValueError('owner_terminal')
        stopped_service(); fd, database = freeze(DATA)
        password = getpass.getpass('One-time transfer password (24+ characters, hidden): ')
        if not re.fullmatch('[A-Za-z0-9_-]{24,256}', password): raise ValueError('password')
        Handler = handler_for(database, password)
        with HTTPServer(('127.0.0.1', 8765), Handler) as server:
            server.timeout = 10; deadline = time.monotonic() + 600
            print('Thread Watch state: transfer ready on loopback for 10 minutes.', flush=True)
            while not Handler.completed and time.monotonic() < deadline: server.handle_request()
        if not Handler.completed: raise ValueError('transfer_incomplete')
        print('Thread Watch state: transfer completed. AWS worker remains disabled.'); return 0
    except (Exception, KeyboardInterrupt):
        print('Thread Watch state: export incomplete. No queue contents displayed.'); return 78
    finally:
        if fd is not None: os.close(fd)

if __name__ == '__main__': sys.exit(main())
