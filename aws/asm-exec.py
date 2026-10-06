#!/usr/bin/env python3
"""Restricted dynamic-reference exec adapter for the hosted Radar process.

Only the running instance uses this wrapper. Agents must never invoke its
resolver, read provider tokens, or inspect the resulting process environment.
"""
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

TOKEN_FIELDS = ('SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN')
NODE = '/opt/thread-watch-node/bin/node'
ENTRY = '/opt/thread-watch/dist/start-hosted.js'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('provider_redirect_refused')

def validate_references(env: dict[str, str]) -> str:
    arn = env.get('RADAR_SLACK_SECRET_ARN', '')
    account = env.get('RADAR_AWS_ACCOUNT_ID', '')
    region = env.get('AWS_REGION', '')
    if not re.fullmatch(r'\d{12}', account) or not re.fullmatch(r'[a-z]{2}(?:-[a-z]+)+-\d', region) or not re.fullmatch(
            r'arn:aws:secretsmanager:' + re.escape(region) + ':' + account + r':secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}', arn):
        raise ValueError('secret_reference_invalid')
    for field in TOKEN_FIELDS:
        expected = '{{resolve:secretsmanager:' + arn + ':SecretString:' + field + ':AWSCURRENT}}'
        if env.get(field) != expected:
            raise ValueError('secret_reference_invalid')
    return arn

def resolve_from_provider(arn: str) -> dict[str, str]:
    # Resolve once, into memory only. No stdout, file, command argument, shell,
    # proxy, remote endpoint or redirect can receive the plaintext values.
    ssrf_token = Path('/var/run/awssmatoken').read_text().strip()
    if not ssrf_token or len(ssrf_token) > 4096:
        raise ValueError('provider_unavailable')
    url = 'http://127.0.0.1:2773/secretsmanager/get?' + urllib.parse.urlencode({'secretId': arn, 'versionStage': 'AWSCURRENT'})
    request = urllib.request.Request(url, headers={'X-Aws-Parameters-Secrets-Token': ssrf_token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=10) as response:
        raw = response.read(32769)
    if len(raw) > 32768:
        raise ValueError('provider_response_invalid')
    outer = json.loads(raw)
    values = json.loads(outer['SecretString'])
    if not isinstance(values, dict) or set(values) != set(TOKEN_FIELDS):
        raise ValueError('secret_fields_invalid')
    for field, prefix in zip(TOKEN_FIELDS, ('xapp-', 'xoxp-', 'xoxb-')):
        value = values[field]
        if not isinstance(value, str) or not len(prefix) < len(value) <= 4096 or not value.startswith(prefix) or not re.fullmatch('[A-Za-z0-9_-]+', value):
            raise ValueError('secret_fields_invalid')
    return values

def main() -> int:
    try:
        env = dict(os.environ)
        arn = validate_references(env)
        checked = subprocess.run([NODE, ENTRY, '--preflight'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if checked.returncode:
            print('Radar hosted: configuration rejected.', file=sys.stderr)
            return 78
        env.update(resolve_from_provider(arn))
        os.execve(NODE, [NODE, ENTRY], env)
    except urllib.error.HTTPError as error:
        print('Radar hosted: secure credential injection unavailable.', file=sys.stderr)
        return 1 if error.code >= 500 else 78
    except urllib.error.URLError:
        print('Radar hosted: credential provider temporarily unavailable.', file=sys.stderr)
        return 1
    except FileNotFoundError:
        print('Radar hosted: credential provider temporarily unavailable.', file=sys.stderr)
        return 1
    except Exception:
        print('Radar hosted: secure credential injection unavailable.', file=sys.stderr)
        return 78

if __name__ == '__main__':
    sys.exit(main())
