# Hosting options and platform support

Thread Watch is a background Slack worker, not an AWS-specific application.
Slack delivers events over an outbound Socket Mode connection; any future host
must provide continuous execution, internet access, private credentials,
durable local SQLite storage and an exclusive worker lease. It needs no public
domain or inbound HTTP port. Hosting the separate consumer is also required if
you want summaries or notifications.

Platform support includes more than starting Node. Credential storage, private
file permissions, service supervision and locking must work on the host too.

| Host | Current support |
| --- | --- |
| macOS computer | Native installer: login Keychain, LaunchAgent and macOS lease checks. Offline checks run in macOS CI. See [macOS setup](macos.md) and its login/reboot limitations. |
| AWS Linux instance | CloudFormation installer, Secrets Manager, systemd and Linux lease checks. Template generation and offline checks run in CI; verify each live deployment. See [AWS setup](aws.md). |
| Other Linux cloud/VPS or home server | The Linux runtime is checked on Ubuntu in CI, but the supplied production launcher retrieves AWS secrets and the installer provisions AWS. There is no generic Linux installer yet. |
| Native Windows computer | No Windows service, credential/permission adapter, worker-lease implementation or Windows CI yet. Native hosting is unsupported. |
| Docker or Windows with WSL2 | No container image or WSL installation guide is provided or tested yet. A Linux container is a potential portability path, not a supported installer today. |

This is the current implementation boundary, not a requirement to use Apple or
Amazon. Other Linux hosts need a credential source, launcher and supervisor;
changing the AWS region or copying the Mac installer does not supply those.

An always-on VM or physical computer is a good fit. An ephemeral function or
short-lived job does not match the continuous WebSocket and durable local queue
without a runtime/storage redesign. Run exactly one worker per installation and
preserve its queue across restarts. Follow [fresh-install acceptance](installation-checklist.md)
for the watcher and consumer together.

## Portability contributions

The Slack filtering, relay contract and queue behavior can be reused. Platform
work belongs around credential access, storage validation, locking and startup:

- **General Linux installer:** accept private host-managed credentials without
  requiring Secrets Manager, prepare private state directories and install a
  supervised service while retaining the inherited exclusive lease.
- **Linux container:** package that runner with persistent private storage,
  credential injection and single-worker enforcement. Test restart recovery and
  file permissions on each supported volume setup, including Windows hosts.
- **Native Windows adapter:** use protected Windows credential storage and
  filesystem ACLs, a Windows background service and an equivalent exclusive
  lease. Add Windows CI before advertising support.

Current Linux lease validation uses `/proc/self/fdinfo`; Python launchers use
`fcntl`, Unix ownership/mode checks and platform-specific paths. Windows needs
real equivalents for those controls. Removing them just to start the process
would lose privacy and duplicate-delivery protections. New adapters should keep
the immutable installation identity, explicit approvals and existing queue/
relay contract, and demonstrate fresh startup, restart recovery and rejection
of a second worker.
