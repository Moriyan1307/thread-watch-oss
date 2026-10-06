#!/usr/bin/env python3
"""Build a source-only archive from an explicit allowlist; never scan secrets."""
import hashlib
import json
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXED = ('package.json', 'package-lock.json', 'aws/hosted-run.py', 'aws/asm-exec.py', 'aws/thread-watch.service', 'aws/install-release.sh')

def build_archive(root: Path, destination: Path) -> dict[str, object]:
    root = root.resolve()
    for directory in ('dist', 'aws'):
        if (root / directory).is_symlink() or not (root / directory).is_dir():
            raise ValueError('Archive directories must be local regular directories')
    files = [root / name for name in FIXED]
    # Only generated JavaScript application code; no source map/private data.
    files += sorted((root / 'dist').glob('*.js'))
    if not (root / 'dist/start-hosted.js').is_file():
        raise ValueError('Build required before packaging')
    for path in files:
        if path.is_symlink() or not path.is_file():
            raise ValueError('Archive inputs must be regular files')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, 'w:gz') as archive:
        for path in files:
            info = archive.gettarinfo(str(path), arcname=path.relative_to(root).as_posix())
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mode = 0o644
            with path.open('rb') as stream:
                archive.addfile(info, stream)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    return {'sha256': digest, 'bytes': destination.stat().st_size, 'files': [p.relative_to(root).as_posix() for p in files]}

def main() -> int:
    if len(sys.argv) != 2:
        print('Specify a local archive destination.', file=sys.stderr)
        return 1
    print(json.dumps(build_archive(ROOT, Path(sys.argv[1]))))
    return 0

if __name__ == '__main__':
    sys.exit(main())
