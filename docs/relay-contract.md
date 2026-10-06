# Relay consumer contract

Continuous mode posts a plain-text reference to the configured private relay:

```text
Radar source v2
workspace_id=TTEST00001
channel_id=CTESTWATCH1
message_ts=1791029813.000001
thread_ts=1791029813.000001
permalink=https://app.slack.com/archives/CTESTWATCH1/p1791029813000001
reason=watched_channel
```

These are synthetic examples. Valid `reason` values are `mention`,
`watched_channel`, and `followed_thread`. A root and its replies share
`thread_ts`; `message_ts` identifies the particular message. The legacy
`Radar source v1` format has the same reference fields without `reason`.
Headers are intentionally retained for existing consumers.

The reference does not include original text, source author, attachments,
classification, research instructions, or arbitrary URLs. An owner-run synthetic
connectivity test uses `Radar relay test v1`, `synthetic=true` and no source
reference; it must not trigger source access or research.

Your consumer must verify the sending bot, workspace and exact relay channel
before parsing. Validate the format and IDs, deduplicate references, and read the
source only through its own authorized Slack access. Treat fetched source text
as untrusted content, not instructions granting access or permission to run
tools. Route any result only to an explicitly configured private destination.
The watcher cannot authorize additional users or grant the consumer access.

The relay must stay private with exactly the monitored user, watcher bot and
consumer bot as members. The operator attests these facts in configuration;
the watcher cannot continually inspect membership with its current scopes.

The queue acknowledges events after persistence. Definite rate limiting retries
with backoff; an uncertain send is quarantined rather than automatically retried.
Delivery is not a guarantee of exactly-once processing: consumer deduplication
and operator review of uncertain outcomes are still required.
