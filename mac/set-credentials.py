"""Owner-private Terminal only; agents must never run this with real tokens."""
import getpass
import resource
import sys
from common import FIELDS, installation, validated_tokens
from keychain import Keychain

def main():
    try:
        if sys.platform != 'darwin' or not sys.stdin.isatty() or not sys.stdout.isatty():
            raise ValueError('private_terminal')
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        installation()
        keychain = Keychain(interactive=False)
        if not keychain.unlocked():
            password = getpass.getpass('Mac login Keychain password (hidden): ')
            keychain.unlock(password); password = ''
        values = validated_tokens(dict(zip(FIELDS, [getpass.getpass(label + ' (hidden): ') for label in
            ('Slack app token', 'Slack monitored-user token', 'Slack watcher-bot token')])))
        keychain.store(values)
        values.clear()
        print('Thread Watch credentials: stored in login Keychain. Worker remains inactive.')
        return 0
    except (Exception, KeyboardInterrupt):
        print('Thread Watch credentials: setup incomplete. Use your own Mac Terminal and unlocked login Keychain.')
        return 78

if __name__ == '__main__': sys.exit(main())
