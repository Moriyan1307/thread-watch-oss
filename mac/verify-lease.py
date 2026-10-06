import sys
from pathlib import Path
from lease import verify_lock

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('arguments')
        verify_lock(Path(sys.argv[1]))
    except Exception:
        sys.exit(78)
