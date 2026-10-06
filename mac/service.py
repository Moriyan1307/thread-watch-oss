"""Prepare safely; activation is a separate owner-confirmed cutover action."""
import argparse
import getpass
import json
import os
import plistlib
import shutil
import stat
import sqlite3
import subprocess
import sys
from pathlib import Path
from common import BASE, DATA, RUN, ROOT, LABEL, PLIST, activation_ready, installation, private_file, runtime_env, write_private, read_configuration
from keychain import Keychain
from lease import private_directory, lease_available, acquire_lock

DOMAIN = 'gui/' + str(os.getuid())

def launch(arguments):
    return subprocess.run(['/bin/launchctl', *arguments], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode

def plist(config):
    return {'Label': LABEL, 'ProgramArguments': [config['python'], str(ROOT / 'mac/run.py')],
        'WorkingDirectory': str(ROOT), 'RunAtLoad': True, 'KeepAlive': {'SuccessfulExit': False},
        'ThrottleInterval': 30, 'ExitTimeOut': 40, 'AbandonProcessGroup': False,
        'Umask': 63, 'SoftResourceLimits': {'Core': 0}, 'HardResourceLimits': {'Core': 0},
        'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null'}

def prepare(config_path: Path | None = None):
    if launch(['print', DOMAIN + '/' + LABEL]) == 0 or (BASE / 'activation.json').exists() or (BASE / 'installation.json').exists():
        raise ValueError('existing_installation')
    configuration = read_configuration(config_path or ROOT / '.env')
    encryption = subprocess.run(['/usr/bin/fdesetup', 'status'], capture_output=True, text=True, check=True).stdout
    if encryption.strip() != 'FileVault is On.': raise ValueError('encrypted_disk_required')
    for directory in (BASE, DATA, RUN):
        directory.mkdir(parents=True, mode=0o700, exist_ok=True); private_directory(directory)
    node = shutil.which('node')
    if not node: raise ValueError('node_missing')
    config = {'version': 1, 'uid': os.getuid(), 'root': str(ROOT),
        'node': str(Path(node).resolve()), 'python': str(Path(sys.executable).resolve())}
    # Check the required runtime capability without opening any real database.
    version = subprocess.check_output([config['node'], '-p', 'process.versions.node'], text=True).strip()
    parts = tuple(map(int, version.split('.')))
    if parts < (22, 18, 0): raise ValueError('node_version')
    checked = subprocess.run([config['node'], str(ROOT / 'dist/start-mac.js'), '--preflight'], env=runtime_env(configuration),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if checked.returncode: raise ValueError('preflight')
    write_private(BASE / 'configuration.json', json.dumps(configuration).encode())
    write_private(BASE / 'installation.json', json.dumps(config).encode())
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    if PLIST.is_symlink() or PLIST.exists(): raise ValueError('existing_plist')
    with PLIST.open('xb') as stream: plistlib.dump(plist(config), stream)
    PLIST.chmod(0o600)
    if launch(['bootstrap', DOMAIN, str(PLIST)]): raise ValueError('login_session_required')
    print('Thread Watch macOS: prepared and inactive. Set credentials privately, then activate.')

def initialize_state(directory: Path):
    """Create a new empty SQLite file under the worker lease; never overwrite state."""
    fd = acquire_lock(directory)
    try:
        path = directory / 'queue.sqlite'
        created = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(created)
        with sqlite3.connect(path) as database:
            database.execute('PRAGMA user_version=0')
    finally:
        os.close(fd)

def activate(fresh: bool = False):
    if not sys.stdin.isatty() or not sys.stdout.isatty(): raise ValueError('private_terminal')
    installation(); private_directory(DATA)
    if fresh:
        if (BASE / 'import.json').exists(): raise ValueError('imported_state')
        if (DATA / 'queue.sqlite').exists():
            receipt = json.loads(private_file(BASE / 'fresh.json', 1024))
            if receipt != {'version': 1, 'uid': os.getuid()}: raise ValueError('existing_state')
            info = (DATA / 'queue.sqlite').lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or not info.st_size:
                raise ValueError('existing_state')
    else:
        receipt = json.loads(private_file(BASE / 'import.json', 1024))
        if receipt.get('version') != 1 or not isinstance(receipt.get('bytes'), int) or receipt['bytes'] <= 0:
            raise ValueError('import_required')
        info = (DATA / 'queue.sqlite').lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size == 0:
            raise ValueError('import_required')
    keychain = Keychain()
    if not keychain.exists(): raise ValueError('credential_setup_required')
    if not keychain.unlocked():
        password = getpass.getpass('Mac login Keychain password (hidden): ')
        keychain.unlock(password); password = ''
    phrase = 'START_NEW_THREAD_WATCH' if fresh else 'AWS_STOPPED_AND_QUEUE_IMPORTED'
    answer = input('Confirm no other worker is active; type ' + phrase + ': ')
    if answer != phrase: raise ValueError('confirmation')
    if fresh and not (DATA / 'queue.sqlite').exists():
        initialize_state(DATA)
        write_private(BASE / 'fresh.json', json.dumps({'version': 1, 'uid': os.getuid()}).encode())
    write_private(BASE / 'activation.json', json.dumps({'version': 1, 'uid': os.getuid(), 'stateReady': True}).encode())
    if launch(['print', DOMAIN + '/' + LABEL]) != 0 and launch(['bootstrap', DOMAIN, str(PLIST)]):
        raise ValueError('login_session_required')
    if launch(['kickstart', DOMAIN + '/' + LABEL]): raise ValueError('start_failed')
    print('Thread Watch macOS: start requested. Verify status and an expected event before declaring setup complete.')

def stop():
    installation()
    path = BASE / 'activation.json'
    if path.exists(): path.unlink()
    launch(['bootout', DOMAIN + '/' + LABEL])
    print('Thread Watch macOS: activation removed and stop requested. Verify worker exit before starting another host.')

def status():
    installation()
    keychain = Keychain()
    values = ['activation=' + ('approved' if activation_ready() else 'inactive'),
        'launch_agent=' + ('loaded' if launch(['print', DOMAIN + '/' + LABEL]) == 0 else 'unloaded'),
        'credentials=' + ('stored' if keychain.exists() else 'not_stored'),
        'keychain=' + ('unlocked' if keychain.unlocked() else 'locked'),
        'worker_lease=' + ('free' if lease_available(DATA) else 'held')]
    allowed = {'prepared_inactive', 'starting', 'stopped', 'retrying', 'lease_already_held', 'configuration_or_keychain_unavailable',
        'started', 'sent', 'retry', 'uncertain', 'reconnecting', 'stopped', 'runtime_failed', 'connecting', 'connected', 'disconnected'}
    for filename, prefix in [('supervisor.json', 'supervisor'), ('status.json', 'runtime')]:
        try:
            value = json.loads(private_file(RUN / filename, 1024))
            label = value.get('status')
            if label in allowed: values.append(prefix + '=' + label)
            pid = value.get('pid')
            if isinstance(pid, int) and pid > 0:
                try: os.kill(pid, 0); alive = True
                except ProcessLookupError: alive = False
                values.append(prefix + '_pid_alive=' + str(alive).lower())
        except FileNotFoundError: values.append(prefix + '=not_recorded')
    print('Thread Watch macOS: ' + ' '.join(values))

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['prepare', 'activate', 'stop', 'status'])
    parser.add_argument('--config', type=Path); parser.add_argument('--fresh', action='store_true')
    arguments = parser.parse_args(); action = arguments.action
    try:
        if sys.platform != 'darwin': raise ValueError('platform')
        if arguments.config and action != 'prepare' or arguments.fresh and action != 'activate': raise ValueError('arguments')
        if action == 'prepare': prepare(arguments.config)
        elif action == 'activate': activate(arguments.fresh)
        else: globals()[action]()
        return 0
    except (Exception, KeyboardInterrupt):
        print('Thread Watch macOS: operation incomplete. Check installation, login session, FileVault and owner setup.'); return 78

if __name__ == '__main__': sys.exit(main())
