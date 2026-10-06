#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH="/opt/thread-watch-node/bin:$PATH"
test "$(id -u)" -eq 0
test "$#" -eq 3
radar_release_bucket="$1"
radar_release_key="$2"
radar_release_sha="$3"
[[ "$radar_release_bucket" =~ ^[a-z0-9.-]+$ ]]
[[ "$radar_release_key" =~ ^releases/[a-f0-9]{64}\.tar\.gz$ ]]
[[ "$radar_release_sha" =~ ^[a-f0-9]{64}$ ]]
radar_release_dir=$(mktemp -d /var/tmp/radar-release.XXXXXX)
trap 'rm -rf "$radar_release_dir"' EXIT
aws s3 cp "s3://$radar_release_bucket/$radar_release_key" "$radar_release_dir/release.tar.gz" --only-show-errors
printf '%s  %s\n' "$radar_release_sha" "$radar_release_dir/release.tar.gz" | sha256sum --check --status
mkdir "$radar_release_dir/code"
tar --extract --gzip --file "$radar_release_dir/release.tar.gz" --directory "$radar_release_dir/code" --no-same-owner
test -f "$radar_release_dir/code/dist/start-hosted.js"
# Every deployment stops the old worker before replacing its code. The kernel
# lease survives until that process exits, and the queue stays on its EBS disk.
if test -f /etc/systemd/system/thread-watch.service; then
  systemctl stop thread-watch.service
fi
rm -rf /opt/thread-watch
install -d -m 0755 -o root -g root /opt/thread-watch
cp -a "$radar_release_dir/code/." /opt/thread-watch/
chown -R root:root /opt/thread-watch
cd /opt/thread-watch
/opt/thread-watch-node/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/var/log/radar-dependency-install.log 2>&1
# The private staging umask must not make root-owned public code unreadable by
# the unprivileged service account. This tree contains only code/dependencies.
find /opt/thread-watch -type d -exec chmod 0755 {} +
find /opt/thread-watch -type f -exec chmod a+r {} +
install -m 0644 aws/thread-watch.service /etc/systemd/system/thread-watch.service
systemctl daemon-reload
systemctl disable thread-watch.service >/dev/null 2>&1
python3 - <<'PY'
from pathlib import Path
path = Path('/etc/thread-watch/runtime.env')
lines = path.read_text().splitlines()
arn = next(line.split('=', 1)[1] for line in lines if line.startswith('RADAR_SLACK_SECRET_ARN='))
lines = [line for line in lines if not line.startswith(('SLACK_APP_TOKEN=', 'SLACK_USER_TOKEN=', 'SLACK_BOT_TOKEN='))]
for field in ('SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN'):
    lines.append(field + '={{resolve:secretsmanager:' + arn + ':SecretString:' + field + ':AWSCURRENT}}')
# Preserve the operator's reviewed watch policy; a code update cannot expand it.
path.write_text('\n'.join(lines) + '\n')
path.chmod(0o600)
PY
# Secret ownership/secure owner entry is verified separately. Installing code
# never starts Slack access or a secret resolver automatically.
printf '%s\n' 'Radar hosted: release installed; service awaits secure activation.'
