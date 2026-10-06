# AWS Linux hosting

The repository includes the existing EC2 hosting approach as a generic template.
The public export is checked offline; it has not been deployed to a new AWS
account. Review the generated template and owner setup before deploying it.
AWS resources and their public IPv4 address incur charges. Stop an old worker
before moving the same Slack installation here.

## Infrastructure

`aws/generate-stack.py` generates `aws/stack.json` without making AWS calls.
The stack uses an ARM64 `t4g.micro`, an encrypted retained queue volume, a private
artifact bucket, an initially empty Secrets Manager secret, and an instance role
limited to that secret and the release prefix. SSM handles administration;
the security group has no inbound ports. Slack connectivity is outbound.

```sh
python3 aws/generate-stack.py
```

Deploy the reviewed template through CloudFormation in your own account. Supply
`AvailabilityZone`, a compatible Amazon Linux 2023 ARM64 `AmiId`, `TeamId`,
`TargetUserId`, `SlackAppId`, `BotUserId`, `BotId`, `ProcessorUserId`,
`RelayChannelId`, and optional comma-separated `WatchChannelIds`. These map to
the README's installation IDs. `RelayVerifiedPrivate` defaults to `denied`;
change it to `approved` only after verifying the exact private three-member relay.
Review IAM creation and account/region selection before deploying.

The bootstrap installs a checksum-verified Node 24 runtime and the AWS Workload
Credentials Provider, mounts the private queue disk, and writes only nonsecret
runtime settings. It does not start the Slack worker. Watch channels, if provided,
are approved by that template deployment; mention-thread following is enabled.
Check the bootstrap completion and local provider availability in SSM before
continuing. The helper supports the standard `aws` partition, not GovCloud/China.

## Credentials and code

Read the stack outputs: `WorkerId`, `ArtifactBucket`, `SlackSecretArn`,
`DataVolumeId`. In an owner-private CloudShell, set `AWS_REGION`,
`RADAR_AWS_ACCOUNT_ID` and `RADAR_SLACK_SECRET_ARN` to your own values and run
`python3 aws/set-slack-secret.py`. It verifies the account/region, prompts with
echo disabled, and stores the three tokens without printing their values.
Never send credentials through SSM command strings, repository files or agents.

Build and package source-only code locally:

```sh
npm ci --ignore-scripts
npm run build
python3 scripts/package-hosted.py /tmp/thread-watch-release.tar.gz
```

The packager prints a SHA256 digest and an allowlisted file inventory. Upload the
archive to the output bucket under `releases/<SHA256>.tar.gz`. Copy
`aws/install-release.sh` to the instance through your reviewed SSM procedure and
run it as root with arguments `<artifact-bucket> releases/<SHA256>.tar.gz <SHA256>`.
It verifies the digest, installs code and locked production dependencies, and
leaves `thread-watch.service` disabled. This is an owner deployment procedure;
tests do not upload or install anything remotely.

`/etc/thread-watch/runtime.env` contains installation IDs and exact dynamic
references to the stack secret. The wrapper requires matching configured account,
region and ARN, obtains credentials from the local provider, and execs Node.
Secrets are process-local; systemd disables core dumps and limits writable paths.
The `radar` service account and `RADAR_` variables retain their existing names.

After reviewing the configuration and confirming no other worker is active:

```sh
sudo systemctl enable --now thread-watch.service
sudo systemctl status thread-watch.service --no-pager
```

Check fixed runtime status in `/run/thread-watch/status.json`, then verify a
natural qualifying event reaches the private relay. Separately check the consumer
result. Do not read or print the secret or private queue as a health check.

## Stop and rollback

```sh
sudo systemctl disable --now thread-watch.service
```

Verify the service is inactive and its process/lease has exited before restarting
another host. Reinstalling a previous reviewed code artifact preserves the queue.
The retained EBS volume, secret and bucket survive stack deletion and can continue
incurring charges; manage retention and cleanup deliberately. State transfer
helpers are optional and owner-only; a new AWS worker can initialize empty state
under its exclusive lease without importing a database.
