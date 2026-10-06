#!/usr/bin/env python3
"""Owner-only hidden input. Run in a private AWS CloudShell, never agent tools."""
import getpass
import json
import os
import re
import subprocess
import sys
import uuid
import warnings

ACCOUNT = os.environ.get('RADAR_AWS_ACCOUNT_ID', '')
REGION = os.environ.get('AWS_REGION', '')
SECRET = os.environ.get('RADAR_SLACK_SECRET_ARN', '')
FIELDS = ('SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN')

def cli(arguments, payload=None):
    return subprocess.run(['aws', *arguments, '--region', REGION, '--no-cli-pager', '--no-cli-auto-prompt', '--output', 'json'],
                          input=payload, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)

def main():
    try:
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            print('Radar setup: use your own private interactive AWS CloudShell.')
            return 1
        if not re.fullmatch(r'\d{12}', ACCOUNT) or not re.fullmatch(r'[a-z]{2}(?:-[a-z]+)+-\d', REGION) or not re.fullmatch(
                r'arn:aws:secretsmanager:' + re.escape(REGION) + ':' + ACCOUNT + r':secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}', SECRET):
            raise ValueError('configuration')
        identity = cli(['sts', 'get-caller-identity', '--endpoint-url', 'https://sts.' + REGION + '.amazonaws.com'])
        if identity.returncode or json.loads(identity.stdout).get('Account') != ACCOUNT:
            print('Radar setup: sign in to the approved AWS account in your private console first.')
            return 1
        print('Store the three existing Radar tokens in its encrypted AWS secret. Input is hidden.')
        values = {}
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            for field, prefix in zip(FIELDS, ('xapp-', 'xoxp-', 'xoxb-')):
                value = getpass.getpass(field + ' (hidden): ')
                if not len(prefix) < len(value) <= 4096 or not value.startswith(prefix) or not re.fullmatch('[A-Za-z0-9_-]+', value):
                    print('Radar setup: invalid format for ' + field + '; nothing was stored.')
                    return 1
                values[field] = value
        response = cli(['secretsmanager', 'put-secret-value', '--secret-id', SECRET,
                        '--client-request-token', str(uuid.uuid4()), '--secret-string', 'file:///dev/stdin',
                        '--endpoint-url', 'https://secretsmanager.' + REGION + '.amazonaws.com'], json.dumps(values))
        values.clear()
        if response.returncode:
            print('Radar setup: secure storage was not confirmed. Share only this status; keep tokens private.')
            return 1
        metadata = json.loads(response.stdout)
        if metadata.get('ARN') != SECRET or 'AWSCURRENT' not in metadata.get('VersionStages', []):
            print('Radar setup: secure storage metadata was not confirmed.')
            return 1
        print('Radar setup: stored securely. Verify configuration before starting your worker.')
        return 0
    except (Exception, KeyboardInterrupt):
        print('Radar setup: stopped; secure storage was not confirmed. Keep tokens private.')
        return 1

if __name__ == '__main__':
    sys.exit(main())
