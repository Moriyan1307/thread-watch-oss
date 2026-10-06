"""LaunchAgent supervisor. Only an activated live worker reads the Keychain."""
import json
import os
import resource
import signal
import subprocess
import sys
from common import DATA, ROOT, activation_ready, fixed_status, installation, runtime_env
from keychain import Keychain
from lease import acquire_lock

def supervise(config, values, env, fd):
    child = None
    stopping = False
    def stop(signum, frame):
        nonlocal stopping
        stopping = True
        if child is not None and child.poll() is None: child.send_signal(signum)
    previous = {s: signal.signal(s, stop) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        payload = json.dumps(values, separators=(',', ':')).encode()
        values.clear()
        child = subprocess.Popen([config['node'], str(ROOT / 'dist/start-mac.js')],
            env=env, stdin=subprocess.PIPE, pass_fds=(fd,))
        if stopping:
            child.terminate(); child.wait(timeout=35); return 0
        try:
            child.stdin.write(payload); child.stdin.close(); payload = b''
        except BaseException:
            if child.poll() is None: child.terminate()
            child.wait(timeout=35)
            if stopping: return 0
            raise
        code = child.wait()
        # launchd's SuccessfulExit=false retries nonzero exits. Permanent
        # configuration/auth failures deliberately park until owner correction.
        return 0 if code in (0, 78) else 1
    finally:
        for signum, handler in previous.items(): signal.signal(signum, handler)
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=35)
            except subprocess.TimeoutExpired: child.kill(); child.wait()

def main():
    fd = None
    try:
        if sys.platform != 'darwin': raise ValueError('platform')
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0)); os.umask(0o077)
        config = installation()
        if not activation_ready():
            fixed_status('prepared_inactive'); return 0
        env = runtime_env(); env['RADAR_MAC_PYTHON'] = config['python']
        checked = subprocess.run([config['node'], str(ROOT / 'dist/start-mac.js'), '--preflight'],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if checked.returncode: raise ValueError('configuration')
        fd = acquire_lock(DATA)
        values = Keychain(interactive=False).read()
        env['RADAR_MAC_ACTIVATION_APPROVED'] = 'approved'
        fixed_status('starting')
        result = supervise(config, values, env, fd)
        fixed_status('stopped' if result == 0 else 'retrying')
        return result
    except BlockingIOError:
        fixed_status('lease_already_held'); return 0
    except Exception:
        try: fixed_status('configuration_or_keychain_unavailable')
        except Exception: pass
        return 0  # Fail closed, no repeated credential prompts or raw errors.
    finally:
        if fd is not None: os.close(fd)

if __name__ == '__main__': sys.exit(main())
