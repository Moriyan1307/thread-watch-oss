# macOS hosting

This is a per-user LaunchAgent, suitable for a Mac that stays awake with the
owner logged in. FileVault must be enabled. It is not a pre-login boot daemon:
after a cold restart, FileVault/login-Keychain recovery can require a local login.
Do not claim unattended reboot recovery until you have verified it on your Mac.

Keep the Mac on power, allow networking, prevent system sleep while plugged in,
and use the laptop with its lid open. Turning off the display is fine. Install
in a stable folder outside macOS-protected Desktop/Documents/Downloads if SSH
privacy permissions are inconvenient. A wired connection is useful but optional.

## Fresh installation

First complete the Slack/consumer setup and `.env` configuration in the
[README](../README.md). No AWS account or database import is required.
Run these commands in your **own private Mac Terminal** from the repository:

```sh
npm ci --ignore-scripts
npm run build
python3 mac/service.py prepare --config .env
python3 mac/set-credentials.py
python3 mac/service.py activate --fresh
python3 mac/service.py status
```

`prepare` validates nonsecret settings, FileVault, the Node runtime and its
preflight. It records absolute Node/Python paths and bootstraps an inactive
LaunchAgent. An existing installation is refused. An nvm-installed Node works;
launchd uses the recorded binary directly and does not source your shell or nvm.
Keep that Node version and the recorded Python binary installed.

`set-credentials.py` prompts with echo disabled for app/user/bot tokens and stores
them as one login-Keychain item. It requires an interactive terminal and does not
activate the worker. Never paste tokens into issues, agent chats, `.env`, command
arguments or the plist. First access may require an owner-approved Keychain
access prompt; a denied or locked Keychain causes the supervisor to stop safely.

`activate --fresh` requires you to confirm no other worker is active by typing
`START_NEW_THREAD_WATCH`. It initializes a private empty SQLite file without
overwriting existing state. The supervisor holds a kernel lease before opening
the queue. Tokens reach Node through an anonymous pipe, not arguments, files or
environment variables.

`status` prints fixed status and credential-storage metadata only. Look for a
held worker lease, live supervisor/runtime PIDs, and `runtime=started` or a later
successful state. Send an ordinary qualifying message from another account and
check that one reference appears in the private relay. Separately verify your
consumer's result. A healthy worker alone does not establish summary delivery.

## Files and maintenance

| Location | Purpose |
| --- | --- |
| `~/Library/Application Support/thread-watch/configuration.json` | Private copy of nonsecret installation settings |
| `~/Library/Application Support/thread-watch/installation.json` | Recorded repository and runtime paths |
| `~/Library/Application Support/thread-watch/data/queue.sqlite` | Private durable worker state |
| `~/Library/Application Support/thread-watch/run/` | Fixed status metadata |
| `~/Library/LaunchAgents/com.moriyan.thread-watch.plist` | User LaunchAgent |
| Login Keychain: service `com.moriyan.thread-watch.slack`, account `configured-installation` | Slack credentials |

Keep the clone in place. To update code, stop the worker, pull reviewed code,
install locked dependencies, rebuild, and reactivate using `--fresh` **only if
this installation originally used fresh activation**. Its receipt preserves the
existing database; it does not reset it. For an imported installation, use
`activate` without that flag. Do not delete state to fix a startup error.

```sh
python3 mac/service.py stop
git pull --ff-only
npm ci --ignore-scripts
npm run build
python3 mac/service.py activate --fresh
python3 mac/service.py status
```

To change installation settings, stop first and edit the private
`configuration.json` using the same keys as `.env.example`; editing the original
`.env` alone does not update an already prepared installation. Restart and verify
the new policy. Changing the monitored installation while reusing its old state
is not a supported migration. Locked credentials, invalid configuration or auth
failures park the supervisor until owner correction; transient runtime failures
use launchd's retry policy.

## Migrating existing AWS state

This path is optional. Stop and disable the old worker before exporting state,
use the owner-only authenticated transfer helpers in `scripts/`, then import a
private stopped SQLite file with `python3 mac/import-state.py /path/to/queue.sqlite`.
Activate without `--fresh`, confirming `AWS_STOPPED_AND_QUEUE_IMPORTED` only when
true. Keep the old worker disabled until the new worker and consumer have been
verified. Never run both hosts or inspect real queue contents through an agent.

## Optional native Keychain check

The default suite mocks Keychain access. On your own unlocked Mac login session,
the optional integration test uses synthetic tokens under a disposable
`com.moriyan.thread-watch.test.*` service and removes its own test item:

```sh
THREAD_WATCH_NATIVE_KEYCHAIN_TEST=1 python3 -m unittest discover -s test -p '*_test.py'
```

This does not exercise real Slack credentials or cold-reboot recovery.
