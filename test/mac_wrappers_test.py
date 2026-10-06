"""Synthetic fixtures only; never read live credentials, logs or queue state."""
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
import urllib.error
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'mac'))
import common
import keychain
import lease

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded); return loaded

runner = module('mac_runner', 'mac/run.py')
service = module('mac_service', 'mac/service.py')
owner = module('mac_owner', 'mac/set-credentials.py')
importer = module('state_import', 'mac/import-state.py')
exporter = module('state_export', 'scripts/owner-export-state.py')
downloader = module('state_download', 'scripts/owner-download-state.py')
TOKENS = dict(zip(common.FIELDS, ('xapp-public-fixture', 'xoxp-public-fixture', 'xoxb-public-fixture')))
CONFIGURATION = common.read_configuration(ROOT / 'examples/demo.env')

class MacWrappersTest(unittest.TestCase):
    def setUp(self):
        # Existing supervisor fixtures must never read an installed configuration.
        override = patch.object(runner, 'runtime_env', side_effect=lambda: common.runtime_env(CONFIGURATION))
        override.start(); self.addCleanup(override.stop)

    def test_inactive_gate_prevents_keychain_lease_node_and_slack_access(self):
        with patch.object(runner, 'installation', return_value={}), patch.object(runner, 'activation_ready', return_value=False), \
                patch.object(runner, 'fixed_status') as status, patch.object(runner, 'Keychain') as credentials, \
                patch.object(runner, 'acquire_lock') as lock, patch.object(runner.subprocess, 'run') as node, \
                patch.object(runner.resource, 'setrlimit'), patch.object(runner.os, 'umask'), patch.object(runner.sys, 'platform', 'darwin'):
            self.assertEqual(runner.main(), 0); status.assert_called_once_with('prepared_inactive')
            credentials.assert_not_called(); lock.assert_not_called(); node.assert_not_called()

    def test_preflight_failure_cannot_resolve_credentials(self):
        with patch.object(runner, 'installation', return_value={'node': '/public/node', 'python': '/public/python'}), \
                patch.object(runner, 'activation_ready', return_value=True), patch.object(runner, 'fixed_status'), \
                patch.object(runner, 'Keychain') as credentials, patch.object(runner, 'acquire_lock') as lock, \
                patch.object(runner.subprocess, 'run', return_value=Mock(returncode=78)), \
                patch.object(runner.resource, 'setrlimit'), patch.object(runner.os, 'umask'), patch.object(runner.sys, 'platform', 'darwin'):
            self.assertEqual(runner.main(), 0); credentials.assert_not_called(); lock.assert_not_called()

    def test_owner_setup_rejects_nonprivate_terminal_before_prompt_or_keychain(self):
        with patch.object(owner.sys.stdin, 'isatty', return_value=False), patch.object(owner.getpass, 'getpass') as prompt, \
                patch.object(owner, 'Keychain') as credentials, patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(owner.main(), 78); prompt.assert_not_called(); credentials.assert_not_called()

    def test_supervisor_uses_anonymous_pipe_and_inherited_fd_without_token_arguments_or_env(self):
        class Pipe:
            def __init__(self): self.value = b''
            def write(self, data): self.value += data
            def close(self): pass
        class Child:
            def __init__(self, code): self.stdin = Pipe(); self.code = code; self.finished = False
            def wait(self, **kwargs): self.finished = True; return self.code
            def poll(self): return self.code if self.finished else None
        for code, expected in [(0, 0), (78, 0), (1, 1)]:
            child = Child(code)
            with patch.object(runner.subprocess, 'Popen', return_value=child) as spawn:
                env = common.runtime_env(CONFIGURATION); values = TOKENS.copy()
                self.assertEqual(runner.supervise({'node': '/public/node'}, values, env, 3), expected)
                self.assertEqual(json.loads(child.stdin.value), TOKENS); self.assertEqual(values, {})
                args, kwargs = spawn.call_args
                self.assertFalse(any('xapp' in arg or 'xox' in arg for arg in args[0]))
                self.assertFalse(any(field in kwargs['env'] for field in common.FIELDS))
                self.assertEqual(kwargs['pass_fds'], (3,)); self.assertEqual(kwargs['stdin'], subprocess.PIPE)

    def test_plist_is_login_scoped_restart_supervision_and_has_no_credentials(self):
        value = service.plist({'python': '/public/python'})
        self.assertEqual(value['KeepAlive'], {'SuccessfulExit': False})
        self.assertFalse(value['AbandonProcessGroup']); self.assertEqual(value['Umask'], 63)
        self.assertEqual(value['HardResourceLimits']['Core'], 0)
        self.assertNotIn('EnvironmentVariables', value); self.assertNotIn('UserName', value)
        self.assertEqual(value['StandardOutPath'], '/dev/null')

    def test_configuration_rejects_tokens_unknown_keys_duplicates_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'settings.env'
            for text in ('SLACK_APP_TOKEN=xapp-public-fixture', 'UNKNOWN=value', 'RADAR_TEAM_ID=TONE\nRADAR_TEAM_ID=TTWO'):
                path.write_text(text)
                with self.assertRaises(ValueError): common.read_configuration(path)
            path.write_text('RADAR_TEAM_ID=TSECOND\nRADAR_USER_ID=USECOND\n')
            self.assertEqual(common.read_configuration(path)['RADAR_TEAM_ID'], 'TSECOND')
            link = Path(temp) / 'linked.env'; link.symlink_to(path)
            with self.assertRaises((ValueError, OSError)): common.read_configuration(link)

    def test_fresh_activation_initializes_private_state_once_and_preserves_it_on_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); base.chmod(0o700); data = base / 'data'; data.mkdir(mode=0o700)
            code = "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import service; service.initialize_state(Path(sys.argv[2]))"
            with patch.object(service, 'BASE', base), patch.object(service, 'DATA', data), \
                    patch.object(service, 'installation', return_value={}), patch.object(service, 'Keychain') as credentials, \
                    patch.object(service, 'launch', return_value=0) as launch, \
                    patch.object(service.sys.stdin, 'isatty', return_value=True), patch.object(service.sys.stdout, 'isatty', return_value=True), \
                    patch('builtins.input', return_value='START_NEW_THREAD_WATCH'), patch('builtins.print'), \
                    patch.object(service, 'initialize_state', side_effect=lambda directory: subprocess.run(
                        [sys.executable, '-c', code, str(ROOT / 'mac'), str(directory)], check=True, capture_output=True)):
                credentials.return_value.exists.return_value = True; credentials.return_value.unlocked.return_value = True
                service.activate(fresh=True)
                database = data / 'queue.sqlite'; original = database.read_bytes()
                self.assertTrue(original.startswith(b'SQLite format 3\x00')); self.assertEqual(database.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads((base / 'activation.json').read_text()), {'version': 1, 'uid': os.getuid(), 'stateReady': True})
                service.activate(fresh=True)
                self.assertEqual(database.read_bytes(), original); credentials.return_value.read.assert_not_called()
                self.assertEqual(launch.call_count, 4)
                (base / 'fresh.json').unlink()
                with self.assertRaises(FileNotFoundError): service.activate(fresh=True)
                self.assertEqual(database.read_bytes(), original)

    def test_fresh_activation_requires_explicit_confirmation_before_creating_state(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); base.chmod(0o700); data = base / 'data'; data.mkdir(mode=0o700)
            with patch.object(service, 'BASE', base), patch.object(service, 'DATA', data), patch.object(service, 'installation', return_value={}), \
                    patch.object(service, 'Keychain') as credentials, patch.object(service, 'initialize_state') as initialize, \
                    patch.object(service, 'launch') as launch, patch.object(service.sys.stdin, 'isatty', return_value=True), \
                    patch.object(service.sys.stdout, 'isatty', return_value=True), patch('builtins.input', return_value='no'):
                credentials.return_value.exists.return_value = True; credentials.return_value.unlocked.return_value = True
                with self.assertRaises(ValueError): service.activate(fresh=True)
                initialize.assert_not_called(); launch.assert_not_called()
                self.assertFalse((base / 'activation.json').exists())

    def test_import_preserves_all_opaque_bytes_and_refuses_existing_or_public_state(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); source = directory / 'fixture.sqlite'; source.write_bytes(b'SYNTHETIC_SQLITE_BYTES\x00FOLLOWED_THREAD_FIXTURE')
            source.chmod(0o600); target = directory / 'imported.sqlite'
            report = importer.import_state(source, target)
            self.assertEqual(source.read_bytes(), target.read_bytes())
            self.assertEqual(report['sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError): importer.import_state(source, target)
            source.chmod(0o644)
            with self.assertRaises(ValueError): importer.import_state(source, directory / 'new.sqlite')

    def test_lease_rejects_symlink_and_public_guards(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); directory.chmod(0o700)
            other = directory / 'other'; other.write_text('fixture'); other.chmod(0o600)
            guard = directory / 'service.lock'; guard.symlink_to(other)
            with self.assertRaises(OSError): lease.acquire_lock(directory)
            guard.unlink(); guard.write_text('fixture'); guard.chmod(0o644)
            with self.assertRaises(ValueError): lease.acquire_lock(directory)

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('node'), 'Actual Darwin Node lease check')
    def test_actual_mac_node_queue_lease_survives_verifier_exit_and_releases_after_crash(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); directory.chmod(0o700)
            source = directory / 'source.sqlite'
            store_module = (ROOT / 'src/store.ts').as_uri()
            mention = {'teamId': 'TTEST', 'channelId': 'CTEST', 'threadTs': '1791029813.000001', 'eventId': 'EvSTATE', 'messageKey': 'state-fixture', 'text': ''}
            seed = f"import {{ SqliteQueue }} from {json.dumps(store_module)}; const q = new SqliteQueue({json.dumps(str(source))}); q.enqueueMonitored({json.dumps(mention)}, Date.now(), true); q.markUncertain('EvSTATE'); q.close()"
            subprocess.run([shutil.which('node'), '--input-type=module', '-e', seed], check=True, capture_output=True)
            importer.import_state(source, directory / 'queue.sqlite')
            script = "import os,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from lease import acquire_lock; acquire_lock(Path(sys.argv[2])); os.execv(sys.argv[3],[sys.argv[3],'--input-type=module','-e',sys.argv[4]])"
            javascript = f"import {{ openMacStore }} from {json.dumps((ROOT / 'src/mac-storage.ts').as_uri())}; const store = openMacStore({json.dumps(str(directory))}, {json.dumps(sys.executable)}); if (!store.queue.followsThread('TTEST','CTEST','1791029813.000001') || store.queue.status('EvSTATE') !== 'uncertain' || store.queue.enqueueMonitored({json.dumps(mention)}, Date.now(), true)) throw new Error('state_not_preserved'); console.log('held'); setInterval(() => {{}}, 1000)"
            command = [sys.executable, '-c', script, str(ROOT / 'mac'), str(directory), shutil.which('node'), javascript]
            first = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(first.stdout.readline().strip(), 'held')
                second = subprocess.run(command, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(second.returncode, 0); self.assertEqual(second.stdout, '')
                first.kill(); first.communicate(timeout=5)
                third = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try: self.assertEqual(third.stdout.readline().strip(), 'held')
                finally: third.kill(); third.communicate(timeout=5)
            finally:
                if first.poll() is None: first.kill()
                first.communicate(timeout=5)

    def test_export_refuses_running_enabled_service_and_unclean_state(self):
        with patch.object(exporter.subprocess, 'run', return_value=Mock(stdout='active\n')):
            with self.assertRaises(ValueError): exporter.stopped_service()
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); directory.chmod(0o700)
            for name in ('service.lock', 'queue.sqlite', 'queue.sqlite-wal'):
                (directory / name).write_bytes(b'SYNTHETIC_STATE'); (directory / name).chmod(0o600)
            with self.assertRaises(ValueError): exporter.freeze(directory)

    def test_download_validates_checksum_and_never_places_password_in_url(self):
        for valid in (True, False):
            with tempfile.TemporaryDirectory() as temp:
                data = b'SYNTHETIC_STATE\x00'; response = Mock()
                response.headers = {'X-State-SHA256': hashlib.sha256(data if valid else b'OTHER').hexdigest(), 'Content-Length': str(len(data))}
                response.read.side_effect = [data, b'']; response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
                opener = Mock(); opener.open.return_value = response; target = Path(temp) / 'fixture.sqlite'
                if valid: downloader.download('PUBLIC_TRANSFER_FIXTURE', target, opener); self.assertEqual(target.read_bytes(), data)
                else:
                    with self.assertRaises(ValueError): downloader.download('PUBLIC_TRANSFER_FIXTURE', target, opener)
                    self.assertFalse(target.exists())
                request = opener.open.call_args.args[0]
                self.assertEqual(request.full_url, 'http://127.0.0.1:18765/queue.sqlite')
                self.assertNotIn('PUBLIC_TRANSFER_FIXTURE', request.full_url)

    def test_real_loopback_transfer_rejects_wrong_auth_and_preserves_verified_state(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp); source = directory / 'fixture.sqlite'; source.write_bytes(b'SYNTHETIC_STATE\x00FOLLOWED_THREAD_FIXTURE')
            Handler = exporter.handler_for(source, 'PUBLIC_TRANSFER_FIXTURE')
            with exporter.HTTPServer(('127.0.0.1', 0), Handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
                endpoint = 'http://127.0.0.1:' + str(server.server_port) + '/queue.sqlite'
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), downloader.NoRedirect())
                class Forward:
                    def open(self, request, timeout):
                        forwarded = urllib.request.Request(endpoint, headers=dict(request.header_items()))
                        return opener.open(forwarded, timeout=timeout)
                try:
                    with self.assertRaises(urllib.error.HTTPError): downloader.download('WRONG_FIXTURE', directory / 'wrong.sqlite', Forward())
                    self.assertFalse(Handler.completed)
                    target = directory / 'download.sqlite'
                    downloader.download('PUBLIC_TRANSFER_FIXTURE', target, Forward())
                    self.assertTrue(Handler.completed); self.assertEqual(source.read_bytes(), target.read_bytes())
                    self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                finally: server.shutdown(); thread.join(timeout=5)

    def test_stop_during_spawn_terminates_child_before_sending_any_credentials(self):
        child = Mock(); child.poll.return_value = 0; child.wait.return_value = 0
        def spawn(*args, **kwargs):
            runner.signal.getsignal(runner.signal.SIGTERM)(runner.signal.SIGTERM, None)
            return child
        with patch.object(runner.subprocess, 'Popen', side_effect=spawn):
            self.assertEqual(runner.supervise({'node': '/public/node'}, TOKENS.copy(), {}, 3), 0)
            child.terminate.assert_called_once(); child.stdin.write.assert_not_called()

    @unittest.skipUnless(sys.platform == 'darwin' and os.environ.get('THREAD_WATCH_NATIVE_KEYCHAIN_TEST') == '1', 'Explicit synthetic namespace only')
    def test_native_keychain_synthetic_item_roundtrip_update_and_cleanup(self):
        service_name = ('com.moriyan.thread-watch.test.' + uuid.uuid4().hex).encode()
        adapter = keychain.Keychain(service=service_name, account=b'public-fixture')
        try:
            self.assertFalse(adapter.exists()); adapter.store(TOKENS.copy())
            self.assertTrue(adapter.exists()); self.assertEqual(adapter.read(), TOKENS)
            changed = {**TOKENS, 'SLACK_APP_TOKEN': 'xapp-public-updated'}
            adapter.store(changed); self.assertEqual(adapter.read(), changed)
            # A fresh process must read the same fixture without an access
            # dialog, matching a background-service restart with this Python.
            code = "import sys; sys.path.insert(0,sys.argv[1]); from keychain import Keychain; values=Keychain(service=sys.argv[2].encode(),account=b'public-fixture').read(); assert values['SLACK_APP_TOKEN']=='xapp-public-updated'; print('fixture_restart_read_ok')"
            child = subprocess.run([sys.executable, '-c', code, str(ROOT / 'mac'), service_name.decode()], capture_output=True, text=True)
            self.assertEqual(child.returncode, 0); self.assertEqual(child.stdout, 'fixture_restart_read_ok\n')
        finally:
            if adapter.exists(): adapter.delete_test_item()

if __name__ == '__main__': unittest.main()
