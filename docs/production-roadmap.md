# Production and Slack distribution roadmap

This is a plan, not a list of shipped features. Baseline: the default branch
after the guided-setup merge, checked on October 9, 2026. Slack policies and
review requirements can change; recheck the linked primary sources before launch.

## What exists today

The repository provides a single-owner metadata watcher, durable queue, strict
identity/access checks, separate consumer adapter, offline demonstrations and
macOS/AWS Linux installers. CI checks macOS/Ubuntu behavior and committed history
for secrets. The public code is MIT-licensed, and private vulnerability reporting
is enabled. Main requires CI, secret scanning, Greptile review and resolved
review conversations; these controls do not establish production availability.

The consumer adapter is not a deployed consumer service. There is no hosted
installation flow, customer account system, multi-workspace installation store,
action inbox, billing or Marketplace listing. The existing signed HTTP ingress
in `src/bolt.ts` is a reusable component, not a distributed app server.

## Choose a problem people will pay to solve

Proposed promise: **show the requests and commitments that still need my
follow-up, with the source and an easy way to dismiss or resolve them.** These
buyer segments are hypotheses, not validated demand:

| Potential buyer | Problem to investigate | Reason they might pay |
| --- | --- | --- |
| Agency/client-delivery lead | Client requests and internal dependencies get buried across channels | Fewer missed client responses and less manual chasing |
| Customer-success lead | Promised answers are forgotten between account conversations | A reliable personal follow-up list without adopting a helpdesk |
| Engineering/product manager | Reviews, decisions and blockers need repeated manual checking | Less time finding what still needs their attention |

Start interviews with one segment: client-delivery leads handling several
channels. Ask for a recent missed request, their current workaround, who owns
the purchase and what would make them stop using the tool. Do not request
private conversations as interview material.

Generic summaries are a weak standalone pitch: Slack already offers
[conversation summaries and daily recaps](https://slack.com/help/articles/25076892548883-Guide-to-AI-features-in-Slack).
ClearFeed already provides [request tracking and commitment reminders](https://clearfeed.ai/features).
These are existing alternatives, not evidence that customers will buy Thread
Watch. Test whether a smaller personal follow-up workflow is useful enough.

The smallest proposed product is:

1. A private inbox of open requests, decisions and commitments, each linked to
   its source. Distinguish a request from an accepted commitment; label uncertain
   owners/deadlines instead of inventing them.
2. Explicit **Done**, **Snooze** and **Not relevant** controls. A reply alone
   does not prove that a request is resolved.
3. A quiet daily brief of new, changed and overdue items, with user-controlled
   channels, timing and mute preferences.

These require durable action state beyond the current 24-hour delivery queue.
An LLM may help classify or explain a source later; it is not required to make
the first workflow useful. Defer automatic replies, task-system integrations,
employee scoring and broad workspace monitoring until users demonstrate a need.

## The installation experience to build

Keep two supported experiences distinct:

- **Self-hosted OSS:** the owner creates their Slack app and owns the credentials,
  state and host. Improve the wizard and supply a complete consumer runner.
- **Proposed hosted service:** we configure the distributed Slack app once.
  A customer authorizes it through OAuth; our service stores the granted tokens
  securely, receives events and runs the processing. Customers operate no server.

The intended hosted journey is:

```text
Add to Slack → review permissions/admin approval → choose allowed channels
→ verify private destination → see a first useful item → set brief preferences
```

OAuth replaces manual token copying for customers. It does not bypass Slack
permissions, workspace admin approval or event subscriptions. We maintain those
subscriptions and a public HTTPS endpoint on our service. Slack's distribution
guide describes [OAuth installation, unlisted pilots and listed apps](https://docs.slack.dev/app-management/distribution/).
Slack Marketplace is an installation/discovery and review channel for this app;
listing the existing Node service does not host it for us.

The current watcher and consumer are separate apps with an exactly verified
private relay. Keep that boundary while completing self-hosting. If a hosted
version replaces the relay with an internal queue, design and test the equivalent
identity, authorization, isolation and private-delivery checks explicitly. Do not
silently weaken the existing relay membership or scope checks to simplify setup.

## Implementation order and release gates

Each stage should produce a runnable result before adding the next feature.
No customer deployment or Slack app changes are performed by this document.

| Stage | Smallest complete result | Evidence required before proceeding |
| --- | --- | --- |
| 1. Complete self-hosted delivery | A documented consumer runner using existing adapters, its own approved credentials, private state and exclusive lease; deterministic output first | A newcomer installs from a fresh clone and completes the [watcher-to-private-update checklist](installation-checklist.md) without an undocumented private workflow |
| 2. Useful personal inbox | Durable open/resolved/snoozed action state, source links, dismiss feedback and a quiet brief | Synthetic tests for false mentions, ambiguous commitments, missing/deleted source, duplicate events and state changes; opt-in users confirm the items are useful |
| 3. Hosted installation | OAuth install/callback, secure installation records, signed HTTP intake, per-owner routing and private delivery | Two different workspaces and two owners in one workspace cannot read, enqueue or deliver each other's data; forged/stale callbacks and events are rejected |
| 4. Operable pilot | Supervised service, persistent state, dependency/rate-limit handling, safe monitoring, recovery and deletion tools | Crash/restart, disk-full, revoked-token, rate-limit and network-loss exercises; restore/rollback rehearsal and an end-to-end pilot receipt |
| 5. Public commercial launch | Stable install/onboarding, privacy/terms/support pages, published retention/deletion policy, reviewed distribution and tested billing | Marketplace eligibility and approval; real retained users who agree to pay; billing cancellation/entitlement checks |

Reuse the installed Slack/Bolt SDKs and queue logic. For a small pilot, isolated
installation workers with private state can preserve the existing one-worker
boundary; a shared installation registry still needs explicit workspace/user/app
ownership and token selection. Never choose a tenant from an untrusted body or
reuse one owner's global environment/credentials for another customer.

### Reliability and privacy work for stages 3–4

- Persist authenticated events before acknowledgement; fetch context and deliver
  asynchronously. Bound processing, queue growth and per-installation API usage.
  Respect `Retry-After`; surface incomplete or stale context rather than guessing.
- Keep cross-workspace/user isolation tests, exclusive worker ownership,
  uncertain-send quarantine and startup credential/scope validation. Handle
  uninstall, user-token revocation and refresh/rotation when enabled.
- Store customer credentials encrypted with restricted service access. Review
  the minimum scopes for the hosted use case; do not automatically copy the
  current private-history permissions into a new public product.
- Track queue age, failures, reconnects, parked sends and delivery delay using
  safe labels. Provide a private operator runbook for incidents, restart,
  ambiguous-send inspection, backup/restore and rollback. Set a measurable
  availability/latency target after observing the pilot, before selling an SLA.
- Define what event metadata, source content, action records, generated outputs
  and backups retain. Implement owner deletion and uninstall cleanup, including
  expiry of backup copies. Document residual Slack retention separately.
- Test lost permissions, missing source and hostile source text. Never execute
  instructions embedded in a message. If adding an AI provider, disclose and
  approve that data flow and configure retention; Slack prohibits using its data
  for LLM training in its [developer policy](https://docs.slack.dev/developer-policy/).

A Mac remains useful for development and personal hosting. Customer availability
must account for sleep, power/network loss, FileVault/login and cold-reboot
recovery; passing an ordinary restart test does not prove 24/7 service. An
operated cloud service can remove these customer-side dependencies, but still
needs its own monitoring and tested recovery.

## Slack Marketplace path

There is a standard developer distribution/review process; this plan does not
assume a Slack partnership or endorsement. Build the app and pilot first, then
submit through Slack's app-management flow. Contact Slack through the documented
review/support route if the proposed use case or permissions need clarification.

Important current constraints:

- **HTTP events are required for Marketplace submission.** Keep Socket Mode for
  private self-hosting; build the hosted route around the existing signed ingress.
  See [Slack's HTTP/Socket Mode comparison](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/).
- **At least 10 active-workspace installations must remain throughout review.**
  This requirement was reaffirmed in Slack's [September 2026 announcement](https://docs.slack.dev/changelog/2026/09/01/slack-marketplace-install-requirement/).
  Also review the weekly-usage and readiness criteria in the
  [Marketplace guidelines](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/).
  Sandboxes and one workspace with many users do not supply ten active workspaces.
- The guidelines require secure tokens, OAuth `state`, TLS and authenticated
  incoming requests. Prepare a scope rationale, install walkthrough, privacy/
  support information and reviewer access; approval is not guaranteed.
- Unlisted distribution is a pilot route, not a plan to evade commercial review.
  Follow the distribution guide's requirement for Marketplace approval for
  commercial distribution and confirm any exception directly with Slack.
- New commercially distributed non-Marketplace apps have stricter source-fetch
  budgets: currently one request/minute and up to 15 messages per request for
  [history](https://docs.slack.dev/reference/methods/conversations.history/) and
  [replies](https://docs.slack.dev/reference/methods/conversations.replies/).
  Internal customer-built and Marketplace apps have different limits. Design
  for the actual app category and `Retry-After`; approval is not unlimited API access.

Open-source licensing and Slack distribution authorization are separate.
Keep the MIT core, contribution path and honest support matrix public. Charging
for managed operation, onboarding and support can coexist with MIT; it does not
permit reclassifying commercial installations as internal apps to avoid review.

## Validate before investing in a large feature set

Interview five target buyers first; this is a proposed research size, not an
existing customer count. Run a small opt-in pilot once installation and delivery
work, then expand to enough real active workspaces for review. Record activation,
repeat usage, useful versus dismissed alerts and follow-ups caught in time.
Track service/API costs per active owner too.

Test willingness to pay for the outcome and managed operation, with a named
buyer and budget. Do not treat installs, positive interviews or an arbitrary
price as proven demand. Add billing after the product and distribution gates
are satisfied. The next engineering task is the complete private consumer runner
and fresh-install acceptance, while interviews validate which inbox to build.
