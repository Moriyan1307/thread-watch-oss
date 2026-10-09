# Contributing

## Start locally

Fork the repository on GitHub, then clone your fork and create a branch:

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/thread-watch-oss.git
cd thread-watch-oss
git switch -c your-change
npm ci --ignore-scripts
npm run demo:relay
```

Use Node.js 24 and Python 3.12 or newer; minimum versions are in the README.
You do not need a Slack workspace, tokens, `.env`, AWS account or running
installation to develop and test offline. Do not start a live worker to test
a contribution. `npm start` intentionally refuses to start one.

## Find the relevant code

| Area | Files |
| --- | --- |
| Event filtering and monitoring | `src/intake.ts`, `src/monitoring.ts` |
| Durable queue, retries and delivery | `src/store.ts`, `src/worker.ts`, `src/relay-runtime.ts` |
| Relay validation and separate consumer | `src/relay.ts`, `src/relay-consumer.ts`, [relay contract](docs/relay-contract.md) |
| Slack transports and API adapters | `src/socket.ts`, `src/bolt.ts`, `src/slack.ts` |
| Guided setup and immutable configuration | `src/setup.ts`, `src/config.ts`, `.env.example`, `manifest.json` |
| Platform credentials, leases and launchers | `mac/`, `aws/`, [hosting support](docs/hosting.md) |
| Synthetic tests and demonstrations | `test/`, `examples/`, [offline demo](docs/demo.md) |

Keep changes small and describe the affected behavior. For changed runtime
behavior, add a test using synthetic identities, temporary private state and
offline ports. Read callers, fixtures and the associated guide before changing
a contract. Update the instructions when a command or platform requirement changes.

## Run the checks

```sh
npm test
npm run typecheck
npm run build
npm run manifest:check
python3 -m unittest discover -s test -p '*_test.py'
npm run demo
npm run demo:relay
```

If you change the AWS generator, run `python3 aws/generate-stack.py` and include
the matching `aws/stack.json` output. Native Keychain integration is opt-in;
the [macOS guide](docs/macos.md) describes its isolated test namespace. Normal
CI does not test a live Slack installation, consumer service or cold reboot.

## Open a pull request

Push your branch to your fork and open a PR against `main`. Explain the problem,
resulting behavior and checks you actually ran; note unverified platform behavior.
For large changes, open an issue first to agree on scope. By submitting a
contribution you agree it will be distributed under the project's [MIT license](LICENSE).

`main` requires a pull request, resolved review conversations, linear history
and up-to-date successful `checks (ubuntu-latest)`, `checks (macos-latest)`,
`secrets` and `Greptile Review`. Human approval is not currently required; the
maintainer decides whether to merge. Do not bypass a failing check or describe
CI success as proof of live delivery.

## Preserve the boundaries

Preserve exact workspace/user/app/scope validation, explicit approval gates,
private relay restrictions, persistence before acknowledgement, worker leases,
and uncertain-send quarantine. Keep monitoring separate from an external
consumer's summaries or research. Do not expand Slack scopes by default.

Never include credentials, real Slack content or IDs, databases, private paths,
deployment handoffs, cloud account identifiers or operational logs. Do not run
live Slack/AWS operations or read installed credentials as part of a test.

For bug reports, include a synthetic reproduction, OS/Node/Python versions and
sanitized status labels. For setup questions, use GitHub issues. Follow
[SECURITY.md](SECURITY.md) for private vulnerability reports. There is no
published support SLA; never post tokens or private content to get help.
