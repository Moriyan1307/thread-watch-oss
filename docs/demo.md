# Two-minute offline demo

```sh
git clone https://github.com/Moriyan1307/thread-watch-oss.git
cd thread-watch-oss
npm ci --ignore-scripts
npm run demo:relay
```

The command creates temporary private SQLite queues and removes them on exit.
It feeds three synthetic source events through the real watcher and relay
consumer code. Slack adapters use offline ports; it does not open a Slack
connection, access Keychain, read private state or contact an AI provider.

Expected output:

```text
Relay: reason=watched_channel (IDs only)
Private summary: From UTEST00001: Demo update: the new build is ready.
Relay: reason=mention (IDs only)
Private summary: From USYNTHETIC123: @UTEST00001 Could you review the demo by tomorrow?
Watcher restarted: followed-thread state preserved.
Relay: reason=followed_thread (IDs only)
Private summary: From USYNTHETIC123: Reminder: prepare the notes before the review.
PASS: 3 sources → 3 metadata relays → 3 private summaries; both queues deduplicate after restart.
Synthetic/offline only. Local rules; no Slack connection, AI provider, or reminders created.
```

`npm run demo` shows the full default local-rule update, including classifications,
deadline hint, context count and source link. To connect a real private consumer,
follow [consumer setup](consumer-setup.md) and then [installation acceptance](installation-checklist.md).
