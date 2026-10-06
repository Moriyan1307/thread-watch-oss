# Security

Report vulnerabilities through this repository's GitHub **Security → Report a
vulnerability** form. If unavailable, open an issue asking for a private reporting
channel without disclosing the vulnerability or any private data. Do not post
tokens, message content, queue files or deployment details in public issues.

This project is intended for one owner-approved Slack installation per worker.
Review its user-history permissions, manually verify relay privacy/membership,
and limit the separate consumer's access and delivery destinations. A public
repository does not make any running installation, credentials or private state
public. Keep installation secrets out of Git history; revoke exposed credentials
rather than relying on deletion of a file or commit.

The current code on the default branch is the supported version. Tests exercise
offline behavior; real workspace authorization, native Keychain approval and
reboot recovery remain installation-specific owner checks.
