# Guided self-hosted setup

The wizard generates the existing nonsecret configuration. Run it in your own
private Terminal; never paste real tokens into an agent chat or an issue.

```sh
npm ci --ignore-scripts
npm run setup
```

## Before you start

1. Create and install a watcher app from [manifest.json](../manifest.json).
   Enable Socket Mode and create its app-level token with only `connections:write`.
   Use the manifest's user history scopes and bot `chat:write`/`im:write` scopes.
2. Prepare a different app/bot as your [relay consumer](consumer-setup.md).
   This repository provides integration code; the wizard does not deploy a
   consumer or add AI functionality.
3. Create a private relay in the same workspace with exactly three members:
   the monitored user, watcher bot and consumer bot.

## What you enter

The two OAuth tokens are entered with echo disabled. Setup calls only
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/) once per token.
It reads no conversations, opens no Socket Mode connection, sends no messages
and requests no new scopes. It rejects missing/extra permissions and mismatched
workspaces, and recognizes the implicit user `identify` scope.

Only three installation IDs need to be copied manually:

| Input | Where to find it |
| --- | --- |
| Watcher app ID (`A…`) | Watcher app's Basic Information page at `api.slack.com/apps` |
| Consumer bot member ID (`U…`) | Open its Slack profile, then choose **Copy member ID** from the menu |
| Private relay channel ID (`C…` or `G…`) | Channel details, **About**, at the bottom |

Enter IDs rather than display names or URLs. Optional watch-channel IDs use the
same channel-details lookup. Leave that prompt empty for mention-only monitoring.
Following later replies is a separate yes/no choice, off unless you approve it.

Setup displays the authenticated workspace/user/bot IDs and the exact expected
relay members. You must verify the relay's privacy, workspace and membership,
the watcher token/app pairing and the separate consumer app in Slack. Current
permissions do not let the wizard discover app IDs or enumerate relay members.

The final review describes history access, monitoring and metadata-only delivery.
Only after you approve that configuration does setup write `.env` with mode
`0600`. It fills the workspace/user/bot IDs, repeated app/member values, exact
scope list, approval flags and local test bounds. Private-DM experiments remain
disabled. Existing files and symlinks are refused before any credential prompts.

## After setup

Follow [macOS hosting](macos.md) to build, prepare the inactive service, store all
three tokens in login Keychain and activate it explicitly. Identity-check tokens
are not retained, so the credential tool asks for them again. Setup does not
read or modify an existing installation, its Keychain or its queue.

For [AWS hosting](aws.md), the generated IDs can help you fill the CloudFormation
parameters, but `.env` is not deployed automatically. AWS account/region,
infrastructure, secret storage and service activation remain the separate
reviewed deployment procedure.

Declining a required confirmation or failing authentication writes no config.
Retry after correcting the prerequisite. For an existing `.env`, use the
advanced manual configuration in the README; for a prepared Mac installation,
follow the documented stop/edit/restart procedure in the macOS guide. Changing
`.env` alone does not reconfigure a prepared service.

This reduces manual configuration; self-hosting still requires Slack apps,
tokens, a consumer and an explicitly verified relay. A hosted product with OAuth
installation is a different future onboarding flow.
