"""Nonsecret paths/configuration. Nothing here reads stored credentials."""
import json
import os
import pwd
import stat
from pathlib import Path
from lease import private_directory

ROOT = Path(__file__).resolve().parent.parent
BASE = Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Application Support/thread-watch'
DATA = BASE / 'data'
RUN = BASE / 'run'
LABEL = 'com.moriyan.thread-watch'
PLIST = Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/LaunchAgents' / (LABEL + '.plist')
FIELDS = ('SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN')
CONFIG_KEYS = frozenset(('RADAR_TEAM_ID', 'RADAR_USER_ID', 'RADAR_APP_ID', 'RADAR_CONFIRMED_SEPARATE_APP_ID',
    'RADAR_BOT_USER_ID', 'RADAR_BOT_ID', 'RADAR_PROCESSOR_USER_ID', 'RADAR_RELAY_CHANNEL_ID',
    'RADAR_RELAY_MEMBER_USER_IDS', 'RADAR_RELAY_VERIFIED_PRIVATE', 'RADAR_VERIFIED_APP_SCOPES',
    'RADAR_ALLOW_SLACK_CONNECTION', 'RADAR_ALLOW_SLACK_READS', 'RADAR_ALLOW_PRIVATE_RELAY',
    'RADAR_ALLOW_CONTINUOUS', 'RADAR_DEPLOYMENT_APPROVED', 'RADAR_WATCH_CHANNEL_IDS',
    'RADAR_ALLOW_CHANNEL_MONITORING', 'RADAR_FOLLOW_MENTION_THREADS', 'RADAR_ALLOW_PRIVATE_DM',
    'RADAR_TEST_DURATION_MS', 'RADAR_TEST_MAX_SUMMARIES'))

def validated_configuration(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or not set(value).issubset(CONFIG_KEYS) or any(
            not isinstance(v, str) or len(v) > 4096 or '\x00' in v or '\n' in v for v in value.values()):
        raise ValueError('configuration')
    return value.copy()

def read_configuration(path: Path) -> dict[str, str]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 16384:
            raise ValueError('configuration')
        with os.fdopen(fd, 'r', closefd=False) as stream: text = stream.read(16385)
        if len(text) > 16384: raise ValueError('configuration')
    finally:
        os.close(fd)
    value = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'): continue
        key, separator, item = line.partition('=')
        if not separator or key in value: raise ValueError('configuration')
        value[key] = item
    return validated_configuration(value)

def private_file(path: Path, limit: int | None = None) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or (limit is not None and info.st_size > limit):
            raise ValueError('unsafe_file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read() if limit is None else stream.read(limit + 1)
    finally:
        os.close(fd)

def write_private(path: Path, data: bytes) -> None:
    private_directory(path.parent)
    temp = path.with_name(path.name + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(fd)
        os.replace(temp, path)
    finally:
        os.close(fd)
        if temp.exists(): temp.unlink()

def installation() -> dict:
    private_directory(BASE)
    value = json.loads(private_file(BASE / 'installation.json', 4096))
    if set(value) != {'version', 'uid', 'root', 'node', 'python'} or value['version'] != 1 or value['uid'] != os.getuid() or value['root'] != str(ROOT):
        raise ValueError('installation')
    for key in ('node', 'python'):
        path = Path(value[key])
        if not path.is_absolute() or path.is_symlink() or not path.is_file() or not os.access(path, os.X_OK):
            raise ValueError('executable')
    return value

def runtime_env(configuration: dict | None = None) -> dict[str, str]:
    if configuration is None:
        private_directory(BASE)
        configuration = json.loads(private_file(BASE / 'configuration.json', 16384))
    return {**validated_configuration(configuration), 'RADAR_DATA_DIRECTORY': str(DATA)}

def activation_ready() -> bool:
    private_directory(BASE)
    path = BASE / 'activation.json'
    if not path.exists(): return False
    value = json.loads(private_file(path, 1024))
    return value == {'version': 1, 'uid': os.getuid(), 'stateReady': True}

def validated_tokens(values: object) -> dict[str, str]:
    import re
    if not isinstance(values, dict) or set(values) != set(FIELDS): raise ValueError('credentials')
    for field, prefix in zip(FIELDS, ('xapp-', 'xoxp-', 'xoxb-')):
        value = values[field]
        if not isinstance(value, str) or not len(prefix) < len(value) <= 4096 or not value.startswith(prefix) or not re.fullmatch('[A-Za-z0-9_-]+', value):
            raise ValueError('credentials')
    return values

def fixed_status(status: str) -> None:
    write_private(RUN / 'supervisor.json', json.dumps({'status': status, 'pid': os.getpid()}).encode())
