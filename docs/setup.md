# Guided self-hosted setup

Run the wizard in your own private terminal. It explains the Slack steps below
before requesting credentials; never paste real tokens into an agent chat or
an issue. A token is a secret password for one specific Slack connection.

After cloning the repository and installing the Node/Python versions listed in
the README, run:

```sh
npm ci --ignore-scripts
npm run setup
```

**A separate, working consumer is required for summaries.** This repository
provides a watcher and reusable consumer integration code, not a ready-to-run
consumer service. Follow [consumer setup](consumer-setup.md) with a developer or
connect an existing authorized workflow. Creating an empty second Slack app
alone does not provide summaries. If you do not have a consumer, you can try
the offline demos now; pause live setup before entering tokens.

## 1. Create your watcher app

1. Sign in to Slack as the person whose mentions you want to watch. Use that
   person's workspace/account when installing the watcher; its user token must
   belong to that person.
2. Open the app-creation link printed by the wizard. To obtain it separately,
   run `npm run setup -- --create-app-link` and copy the `https://` URL.
3. Select your workspace, review the prefilled settings and create the app.
   It is named **Thread Watch**. The manifest supplies the exact user/bot
   permissions, message-event subscriptions and Socket Mode setting.

If the link does not load, go to the [Slack app dashboard](https://api.slack.com/apps),
choose **Create New App**, then **From a manifest**. Select the workspace and
paste the JSON produced by `node scripts/print-manifest.mjs`. Review and create.
Do not use **From scratch** or add permissions to get past a later error.

This uses Slack's documented [manifest-sharing flow](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/).
The link contains public app settings, not tokens. It opens Slack's creation
screen; it does not create or install an app automatically. No configuration
token or Slack CLI installation is needed.

## 2. Install the app and locate two OAuth tokens

1. In your new app's sidebar, open **OAuth & Permissions**.
2. Choose **Install to Workspace** (or reinstall if Slack asks), review the
   requested access and choose **Allow**. If approval is required, ask your
   workspace administrator and wait for approval before continuing.
3. On that page, locate **User OAuth Token** (`xoxp-…`) and **Bot User OAuth
   Token** (`xoxb-…`). Keep the page available for the wizard's hidden prompts.

The user token lets the watcher receive events accessible to the monitored user.
Its history grants also permit reading that user's accessible conversations,
including private ones. The bot token lets the separate watcher identity post
references into the private relay. The wizard makes only identity/permission
checks; the continuous relay worker does not fetch full thread history.

Expected user grants: `channels:history`, `groups:history`, `im:history`,
`mpim:history`. Expected bot grants: `chat:write`, `im:write`. Missing tokens or
different grants mean installation needs correcting; the wizard rejects extra
permissions too. Slack's implicit user `identify` scope is recognized.

## 3. Generate the Socket Mode token

1. Open **Basic Information** in the same app's sidebar.
2. Under **App-Level Tokens**, choose **Generate Token and Scopes**.
3. Give it a descriptive name, such as `thread-watch-connection`. Add only
   `connections:write`, then generate it.
4. Keep this app-level token (`xapp-…`) for the host credential tool later.
   The wizard does not ask for or store this third token.

The [Socket Mode connection](https://docs.slack.dev/apis/events-api/using-socket-mode/)
lets Slack deliver events over an outbound connection. The manifest enables it;
you do not need a public URL, domain or tunnel for this worker.

## 4. Connect the consumer and create the private relay

1. Connect your working consumer bot from a **different Slack app** in the
   same workspace. It must receive relay references and use its own authorized
   connection to access source threads. See [consumer setup](consumer-setup.md).
2. In Slack, use **Add channels** / **Create a new channel**, give the relay a
   name such as `thread-watch-relay`, and choose **Private**.
3. Add the watcher bot and consumer bot to the channel. Verify its privacy and
   member list in channel details. It must have exactly three members: you,
   the watcher bot and consumer bot. Do not add other people or apps.

The consumer delivers summaries or notifications; the watcher only forwards
IDs and timestamps. Keep the consumer running alongside the watcher. The wizard
asks you to confirm these prerequisites before any credential prompts or API
calls. If you are not ready, answer **no**, finish the missing step and rerun.

## 5. Complete the wizard

Approve read-only identity/permission checks if you want to proceed. Enter the
two OAuth tokens when prompted; input echo is disabled. Setup calls only
[`auth.test`](https://docs.slack.dev/reference/methods/auth.test/) once per token.
It reads no conversations, opens no Socket Mode connection, sends no messages
and requests no new scopes. It rejects mismatched workspaces and permissions.

Only three installation IDs need to be copied manually:

| Input | Where to find it |
| --- | --- |
| Watcher app ID (`A…`) | Watcher app's **Basic Information** page |
| Consumer bot member ID (`U…`) | Open its Slack profile, then **Copy member ID** from the menu |
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
`0600`. It fills discovered IDs, repeated values, scope lists and approval flags.
Private-DM experiments remain disabled. Existing files and symlinks are refused
before any credential prompts. Successful setup means configuration is ready;
the watcher and consumer are not started or tested by this command.

## 6. Choose hosting and verify delivery

See [hosting options and platform support](hosting.md). For [macOS hosting](macos.md),
build, prepare the inactive service, store all three tokens in login Keychain
and activate explicitly. The wizard does not retain identity-check tokens, so
the credential tool asks for them again. It does not read or modify an existing
installation, its Keychain or its queue.

For [AWS hosting](aws.md), the generated IDs help fill CloudFormation parameters,
but `.env` is not deployed automatically. AWS account/region, infrastructure,
secret storage and activation remain a separate deployment procedure.

Complete [fresh-install acceptance](installation-checklist.md), including a
natural qualifying Slack event and delivery through your separate consumer.
An identity check alone does not prove summaries work.

Declining a required confirmation or failing authentication writes no config.
Retry after correcting the prerequisite. For an existing `.env`, use the manual
configuration in the README; for a prepared Mac service, follow the documented
stop/edit/restart procedure. Changing `.env` alone does not reconfigure it.

## What can be automated further?

The prefilled manifest and generated configuration remove repeated settings and
ID entry. Slack still requires a user to choose a workspace and grant access;
administrators may require approval. Tokens, the external consumer, relay
privacy verification and host activation remain manual in this version.

Slack's [manifest creation API](https://docs.slack.dev/reference/methods/apps.manifest.create/)
can create apps programmatically, but requires an additional app-configuration
token. That adds privileged credential setup for beginners. This wizard uses
the simpler browser flow. A future hosted product could use OAuth for one shared
app and deploy its own consumer, removing per-customer app creation and hosting;
that service is not included here.
