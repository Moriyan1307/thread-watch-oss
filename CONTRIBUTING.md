# Contributing

Keep changes small and describe the affected behavior. Run the offline checks
listed in the README before submitting a pull request. Add a test for changed
behavior using synthetic identities, temporary private state and offline ports.

Preserve exact workspace/user/app/scope validation, explicit approval gates,
private relay restrictions, persistence before acknowledgement, worker leases,
and uncertain-send quarantine. Keep monitoring separate from an external
consumer's summaries or research. Do not expand Slack scopes by default.

Never include credentials, real Slack content or IDs, databases, private paths,
deployment handoffs, cloud account identifiers or operational logs. Do not run
live Slack/AWS operations or read installed credentials as part of a test.
