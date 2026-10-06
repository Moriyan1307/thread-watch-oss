"""Offline fixtures only: never run the actual credential provider/resolver."""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parent.parent

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

adapter = module('adapter', 'aws/asm-exec.py')
packager = module('packager', 'scripts/package-hosted.py')
ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:thread-watch/slack-PUBLIC'
with patch.dict(os.environ, {'RADAR_AWS_ACCOUNT_ID': '000000000000', 'AWS_REGION': 'us-east-1', 'RADAR_SLACK_SECRET_ARN': ARN}):
    owner = module('owner', 'aws/set-slack-secret.py')
FIELDS = ('SLACK_APP_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN')
REFERENCES = {'RADAR_SLACK_SECRET_ARN': ARN, 'RADAR_AWS_ACCOUNT_ID': '000000000000', 'AWS_REGION': 'us-east-1',
    **{f: '{{resolve:secretsmanager:' + ARN + ':SecretString:' + f + ':AWSCURRENT}}' for f in FIELDS}}
FIXTURE_TOKENS = dict(zip(FIELDS, ('xapp-public-fixture', 'xoxp-public-fixture', 'xoxb-public-fixture')))

class HostedWrappersTest(unittest.TestCase):
    def test_secret_reference_must_match_configured_account_and_region(self):
        for changed in ({'RADAR_AWS_ACCOUNT_ID': '111111111111'}, {'AWS_REGION': 'us-west-2'}, {'RADAR_AWS_ACCOUNT_ID': ''}):
            with self.assertRaises(ValueError): adapter.validate_references({**REFERENCES, **changed})

    def test_owner_handoff_refuses_wrong_account_before_hidden_input(self):
        with patch.object(owner.sys.stdin, 'isatty', return_value=True), patch.object(owner.sys.stdout, 'isatty', return_value=True), patch.object(owner, 'cli', return_value=Mock(returncode=0, stdout=json.dumps({'Account':'OTHER'}))) as cli, patch.object(owner.getpass, 'getpass') as prompt, patch('sys.stdout', new_callable=io.StringIO) as output:
            # Patch StringIO's terminal check after redirecting stdout.
            with patch.object(owner.sys.stdout, 'isatty', return_value=True): self.assertEqual(owner.main(), 1)
            self.assertEqual(cli.call_count, 1); prompt.assert_not_called()

    def test_owner_handoff_passes_values_only_through_stdin_and_prints_fixed_status(self):
        calls = []
        def cli(arguments, payload=None):
            calls.append((arguments, payload))
            if arguments[0] == 'sts': return Mock(returncode=0, stdout=json.dumps({'Account':owner.ACCOUNT}))
            return Mock(returncode=0, stdout=json.dumps({'ARN':owner.SECRET, 'VersionStages':['AWSCURRENT']}))
        with patch.object(owner.sys.stdin, 'isatty', return_value=True), patch.object(owner, 'cli', side_effect=cli), patch.object(owner.getpass, 'getpass', side_effect=list(FIXTURE_TOKENS.values())), patch('sys.stdout', new_callable=io.StringIO) as output:
            with patch.object(owner.sys.stdout, 'isatty', return_value=True): self.assertEqual(owner.main(), 0)
            self.assertEqual(json.loads(calls[1][1]), FIXTURE_TOKENS)
            self.assertFalse(any('xox' in arg or 'xapp' in arg for arg in calls[1][0]))
            self.assertFalse('xox' in output.getvalue() or 'xapp' in output.getvalue())

    def test_invalid_reference_and_failed_preflight_never_resolve(self):
        for env, code in [({**REFERENCES, 'SLACK_USER_TOKEN': 'xoxp-public-fixture'}, 0), (REFERENCES, 78)]:
            with patch.dict(os.environ, env, clear=True), patch.object(adapter.subprocess, 'run', return_value=Mock(returncode=code)), patch.object(adapter, 'resolve_from_provider') as resolve, patch.object(adapter.os, 'execve') as execute, redirect_stderr(io.StringIO()):
                self.assertEqual(adapter.main(), 78)
                resolve.assert_not_called(); execute.assert_not_called()

    def test_valid_reference_injects_only_in_exec_environment(self):
        class Executed(BaseException): pass
        with patch.dict(os.environ, REFERENCES, clear=True), patch.object(adapter.subprocess, 'run', return_value=Mock(returncode=0)), patch.object(adapter, 'resolve_from_provider', return_value=FIXTURE_TOKENS.copy()), patch.object(adapter.os, 'execve', side_effect=Executed) as execute:
            with self.assertRaises(Executed): adapter.main()
            node, arguments, child_env = execute.call_args.args
            self.assertEqual(arguments, [adapter.NODE, adapter.ENTRY])
            self.assertFalse(any('xox' in argument or 'xapp' in argument for argument in arguments))
            self.assertEqual({f: child_env[f] for f in FIELDS}, FIXTURE_TOKENS)
            self.assertEqual({f: os.environ[f] for f in FIELDS}, {f: REFERENCES[f] for f in FIELDS})

    def test_booting_provider_is_retryable_without_raw_error_output(self):
        with patch.dict(os.environ, REFERENCES, clear=True), patch.object(adapter.subprocess, 'run', return_value=Mock(returncode=0)), patch.object(adapter, 'resolve_from_provider', side_effect=FileNotFoundError('private-fixture-error')), patch.object(adapter.os, 'execve') as execute, redirect_stderr(io.StringIO()) as output:
            self.assertEqual(adapter.main(), 1); execute.assert_not_called()
            self.assertNotIn('private-fixture-error', output.getvalue())

    def test_provider_parser_is_bounded_and_rejects_extra_secret_fields(self):
        for values, valid in [(FIXTURE_TOKENS, True), ({**FIXTURE_TOKENS, 'EXTRA': 'private-fixture'}, False), ({**FIXTURE_TOKENS, 'SLACK_APP_TOKEN': 'wrong-prefix'}, False)]:
            response = Mock(); response.read.return_value = json.dumps({'SecretString': json.dumps(values)}).encode()
            opener = Mock(); opener.open.return_value.__enter__ = Mock(return_value=response); opener.open.return_value.__exit__ = Mock(return_value=False)
            with patch.object(adapter.Path, 'read_text', return_value='public-provider-fixture'), patch.object(adapter.urllib.request, 'build_opener', return_value=opener):
                if valid: self.assertEqual(adapter.resolve_from_provider(ARN), FIXTURE_TOKENS)
                else:
                    with self.assertRaises(ValueError): adapter.resolve_from_provider(ARN)
                response.read.assert_called_once_with(32769)
                request = opener.open.call_args.args[0]
                self.assertTrue(request.full_url.startswith('http://127.0.0.1:2773/secretsmanager/get?'))

    def test_kernel_lease_excludes_second_worker_and_releases_after_crash(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); directory.chmod(0o700)
            code = "import importlib.util,sys,time; from pathlib import Path; s=importlib.util.spec_from_file_location('lease',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.acquire_lock(Path(sys.argv[2])); print('held',flush=True); time.sleep(30)"
            command = [sys.executable, '-c', code, str(ROOT / 'aws/hosted-run.py'), str(directory)]
            first = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(first.stdout.readline().strip(), 'held')
                second = subprocess.run(command, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(second.returncode, 0)
                self.assertEqual(second.stdout, '')
                first.kill(); first.wait(timeout=5)
                third = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try: self.assertEqual(third.stdout.readline().strip(), 'held')
                finally: third.kill(); third.communicate(timeout=5)
                self.assertTrue((directory / 'service.lock').is_file())
            finally:
                if first.poll() is None: first.kill()
                first.communicate(timeout=5)

    def test_archive_excludes_private_data_and_rejects_symlinked_source_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'project'; root.mkdir(); (root / 'dist').mkdir(); (root / 'aws').mkdir()
            for name in packager.FIXED:
                (root / name).write_text('public fixture')
            (root / 'dist/start-hosted.js').write_text('// public code')
            for directory in ('data', '.slack', 'node_modules'):
                (root / directory).mkdir(); (root / directory / 'private').write_text('PRIVATE_SENTINEL')
            (root / '.env').write_text('PRIVATE_SENTINEL')
            destination = Path(temp) / 'release.tar.gz'
            report = packager.build_archive(root, destination)
            with tarfile.open(destination) as archive:
                self.assertEqual(set(archive.getnames()), set(packager.FIXED) | {'dist/start-hosted.js'})
                self.assertFalse(any(b'PRIVATE_SENTINEL' in archive.extractfile(member).read() for member in archive.getmembers()))
            self.assertEqual(report['bytes'], destination.stat().st_size)
            (root / 'dist/start-hosted.js').unlink(); (root / 'dist').rmdir(); (root / 'dist').symlink_to(ROOT / 'dist', target_is_directory=True)
            with self.assertRaises(ValueError): packager.build_archive(root, destination)

if __name__ == '__main__': unittest.main()
