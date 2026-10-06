# Thread Watch development boundaries

Work in this repository. Keep source, test fixtures and documentation generic.
Never access real Slack tokens, production Keychain entries, private databases,
message content, AWS secrets or process environments to develop or test changes.
Never activate a real worker, install a Slack app, send Slack messages, change
OAuth scopes or deploy infrastructure without an explicit user request.

Installation identities are immutable inputs loaded at process startup. Keep
authenticated identity/scope checks, explicit access gates, verified private
relay membership, loop prevention, metadata-only forwarding, exclusive worker
leases, durable acknowledgment, and uncertain-delivery quarantine intact.

Use synthetic IDs and temporary state in tests. Native Keychain tests are opt-in
and may use only `com.moriyan.thread-watch.test.*` entries. Do not modify a live
installation while preparing an open-source release.

Checks: `npm test`, `npm run typecheck`, `npm run build`,
`npm run manifest:check`, and
`python3 -m unittest discover -s test -p '*_test.py'`.

Keep behavior implemented in the watcher distinct from behavior implemented by
an external relay consumer. No external research provider is enabled here.
