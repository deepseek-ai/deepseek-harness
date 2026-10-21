"""Discover, capture and operate an owned nonactivating floating panel on macOS."""
import argparse
import base64
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import tempfile
import time

from native_test_support import ROOT, NativeHelper, line, run_cleanup, stop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, help='Existing native helper executable')
    args = parser.parse_args()
    if os.uname().sysname != 'Darwin':
        raise RuntimeError('This check requires macOS')
    helper = NativeHelper([], args.helper)
    fixture = None
    try:
        capabilities = helper.call('getCapabilities', {})
        if capabilities['sessionLocked'] is not False or capabilities['permissions'] != {'accessibility': True, 'screenRecording': True}:
            raise RuntimeError('An unlocked Mac with Accessibility and Screen Recording grants is required')
        with tempfile.TemporaryDirectory(prefix='dsh-floating-window-') as directory:
            root = Path(directory)
            contents = root / 'FloatingFixture.app/Contents'
            (contents / 'MacOS').mkdir(parents=True)
            (contents / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': 'org.deepseek-harness.' + root.name,
                'CFBundleExecutable': 'fixture', 'CFBundleName': 'Floating fixture', 'CFBundlePackageType': 'APPL',
            }))
            binary = contents / 'MacOS/fixture'
            subprocess.run(['swiftc', str(ROOT / 'tests/FloatingWindowFixture.swift'), '-o', str(binary)], check=True)
            state_path = root / 'state.json'
            fixture = subprocess.Popen([str(binary), str(state_path)], stdout=subprocess.PIPE, text=True)
            try:
                assert line(fixture).strip() == 'READY'

                def wait_state(predicate):
                    deadline = time.monotonic() + 10
                    while True:
                        state = json.loads(state_path.read_text())
                        assert state['pid'] == fixture.pid, state
                        if predicate(state):
                            return state
                        if time.monotonic() >= deadline:
                            raise AssertionError('Fixture state did not settle: ' + json.dumps(state))
                        time.sleep(0.025)

                actual = wait_state(lambda value: value['panelOnScreen'] and value['panelLayer'] > 0)
                app = helper.call('getApp', {'selector': str(fixture.pid)})
                owner = {'appHandle': app['appHandle']}
                panel_id = actual['panelWindowId']
                params = {**owner, 'maxElements': 100, 'maxDepth': 15}
                panel = {**params, 'windowId': panel_id}
                windows = helper.call('listWindows', owner)
                assert panel_id in [window['windowId'] for window in windows], windows
                assert all(window['pid'] == fixture.pid for window in windows), windows
                listed = next(window for window in windows if window['windowId'] == panel_id)
                assert listed['onCurrentSpace'] is True, listed
                application = helper.call('getState', params)
                assert application['focusedWindowId'] == actual['mainWindowId'], application
                assert panel_id in [window['windowId'] for window in application['windows']], application
                observed = helper.call('getState', panel)
                assert 'Increment floating panel' in observed['tree'], observed
                assert panel_id in [window['windowId'] for window in observed['windows']], observed
                x, y = actual['buttonPoint']
                target = {**owner, 'windowId': panel_id, 'snapshotId': observed['snapshotId'], 'x': x, 'y': y}
                helper.call('click', target)
                wait_state(lambda value: value['count'] == 1)
                main_capture = helper.call('screenshot', {**owner, 'windowId': actual['mainWindowId']})
                capture = helper.call('screenshot', {**owner, 'windowId': panel_id})
                assert capture['windowId'] == panel_id and main_capture['windowId'] == actual['mainWindowId']
                assert [capture['bounds']['width'], capture['bounds']['height']] == actual['panelSize'], capture
                assert capture['bounds'] != main_capture['bounds'], (capture['bounds'], main_capture['bounds'])
                assert base64.b64decode(capture['data'], validate=True).startswith(b'\x89PNG\r\n\x1a\n')
                helper.call('click', target)
                wait_state(lambda value: value['count'] == 2)
                helper.call('listWindows', owner)
                helper.call('click', target)
                wait_state(lambda value: value['count'] == 3)
                helper.call('getState', params)
                helper.call('click', target)
                wait_state(lambda value: value['count'] == 4)
                os.kill(fixture.pid, signal.SIGUSR2)
                actual = wait_state(lambda value: value['resized'] and value['panelSize'] != actual['panelSize'])
                helper.call('click', target, 'WINDOW_CHANGED')
                fresh = helper.call('getState', panel)
                helper.call('click', target, 'STALE_SNAPSHOT')
                x, y = actual['buttonPoint']
                target = {**target, 'snapshotId': fresh['snapshotId'], 'x': x, 'y': y}
                helper.call('click', target)
                wait_state(lambda value: value['count'] == 5)
                # AppKit's current mouse event retains its target window. Closing from the main
                # window replaces that event so the floating window can actually be destroyed.
                close_x, close_y = actual['closePoint']
                helper.call('click', {**owner, 'windowId': actual['mainWindowId'], 'x': close_x, 'y': close_y})
                wait_state(lambda value: value['closed'] and not value['panelOnScreen'])
                deadline = time.monotonic() + 10
                while panel_id in [window['windowId'] for window in helper.call('listWindows', owner)]:
                    if time.monotonic() >= deadline:
                        raise AssertionError('Closed panel remains in WindowServer inventory')
                    time.sleep(0.025)
                helper.call('click', target, 'STALE_SNAPSHOT')
                helper.call('getState', panel, 'WINDOW_UNAVAILABLE')
                helper.call('screenshot', {**owner, 'windowId': panel_id}, 'WINDOW_UNAVAILABLE')
                helper.eof()
                print('PASS: floating discovery, Space metadata, scoped AX, distinct captures, five received clicks, refresh, resize and close')
            finally:
                stop(fixture)
                fixture.stdout.close()
                fixture = None
    finally:
        run_cleanup(lambda: stop(fixture) if fixture is not None else None, helper.stop)


if __name__ == '__main__':
    main()
