# Fresh-install acceptance

Use a separate Slack test installation with synthetic content and private test
channels. Do not run a second watcher against an existing production installation.
Follow the README and macOS/AWS guide from a fresh clone; enter credentials only
through the owner's private setup. Keep real IDs and receipts out of public docs.

1. Confirm watcher and consumer are different apps and their identities/access
   match configuration. Verify the relay is private with exactly three members.
2. Start the watcher once. Check its fixed startup/lease/PID status, then the
   consumer's authenticated trigger and private destination.
3. In the approved test watch channel, post `Demo update: build ready` without a
   mention. Expect one `watched_channel` reference and one private update.
4. From another human test account, mention the monitored user in a different
   test channel. Expect one `mention` reference and one private update.
5. Reply to that thread without another mention. Expect one `followed_thread`
   reference and one private update. An unrelated thread outside the watch
   allowlist should produce neither.
6. Stop/restart the same watcher and consumer using their documented commands.
   Post one later reply to the followed thread; confirm tracking survived and
   only one new update appears. Event replay/duplicate delivery should not
   generate another update while dedupe records remain.
7. Verify locked-Keychain recovery privately on macOS. Cold reboot/FileVault
   recovery is a separate availability test, not implied by an ordinary restart.

For each case, record pass/fail and counts locally without source/private summary
text. Verify both the relay and private destination: `runtime=sent` proves only
the relay step. If a stage is missing, stop at that stage and keep the installation
test marked incomplete rather than treating offline fixtures as live evidence.
