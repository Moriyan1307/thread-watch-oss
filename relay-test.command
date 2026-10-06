#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
exec npm run relay:test:live
