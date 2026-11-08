"""Verify nested helper extraction and concurrent launchers without granting macOS permissions."""
import argparse
import concurrent.futures
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import tempfile
import uuid

from native_test_support import copy_helper, default_binary, unregister_helper
from shared_helper_e2e import Connection, wait_released


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, default=None)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='cua-nest-', dir='/tmp') as temporary, ExitStack() as cleanup:
        root = Path(temporary)
        parent = root / 'Desktop.app' / 'Contents' / 'Resources'
        parent.mkdir(parents=True)
        helper = copy_helper(args.helper or default_binary(), parent)
        application = helper.parents[2]
        manifest = application / 'Contents/Info.plist'
        info = plistlib.loads(manifest.read_bytes())
        info['CFBundleIdentifier'] = 'dev.dsh.cua.nested-test.' + uuid.uuid4().hex
        manifest.write_bytes(plistlib.dumps(info))
        subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(application)],
                       check=True, capture_output=True, timeout=30)
        key = hashlib.sha256(helper.read_bytes()).hexdigest()
        cache = Path.home() / 'Library/Application Support/DeepSeek Harness/Computer Use'
        generation = cache / key
        assert not generation.exists(), 'The unique signed fixture unexpectedly shares an existing generation'
        cleanup.callback(lambda: (cache / (key + '.lock')).unlink(missing_ok=True))
        cleanup.callback(lambda: shutil.rmtree(generation) if generation.exists() else None)
        copied_helper = generation / application.name / 'Contents/MacOS/dsh-cua-native'
        cleanup.callback(unregister_helper, copied_helper)
        runtime = [root / 'a', root / 'b']

        def stop_owned(directory, pid):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            wait_released(directory / (key + '.lock'), pid)

        def launch(directory):
            result = subprocess.run([str(helper), '--ensure-shared', '--runtime-key', key,
                                     '--runtime-directory', str(directory), '--startup-timeout-ms', '15000'],
                                    check=True, capture_output=True, text=True, timeout=25)
            ready = json.loads(result.stdout)
            cleanup.callback(stop_owned, directory, ready['pid'])
            client = Connection(directory / (key + '.sock'), key)
            cleanup.callback(client.close)
            return client

        # Separate launcher processes share the installation lock while retaining independent service sockets.
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            clients = list(workers.map(launch, runtime))
        for client in clients:
            state = client.call('permissionStatus', {})
            assert Path(state['helper']['path']).resolve() == copied_helper.resolve(), state
            assert Path(state['launchApplication']['path']).resolve() == copied_helper.parents[2].resolve(), state
            assert not any(part.endswith('.app') for part in copied_helper.parents[3].parts), state
        assert clients[0].ready['pid'] != clients[1].ready['pid']
        assert copied_helper.read_bytes() == helper.read_bytes()
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(copied_helper.parents[2])],
                       check=True, capture_output=True, timeout=30)
        print('PASS: concurrent launchers use the same signature-preserving standalone application and drain both helpers')


if __name__ == '__main__':
    main()
