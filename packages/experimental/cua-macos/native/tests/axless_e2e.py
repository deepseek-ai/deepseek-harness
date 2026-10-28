"""Opt-in AX-present -> AXless -> AX-present window regression; requires an unlocked Mac.

Build the helper first. This runner compiles only its owned AppKit fixture,
changes no system permission settings, and controls no user applications.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import plistlib
import signal
import shutil
import subprocess
import tempfile
import time

from native_test_support import ROOT, NativeHelper, run_cleanup
from capabilities_e2e import stop_application


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, help="Existing native helper executable for this run")
    args = parser.parse_args()
    if os.uname().sysname != 'Darwin':
        raise RuntimeError('this opt-in check requires macOS')
    helper = NativeHelper([], args.helper)
    fixture = None
    foreground = None
    try:
        capabilities = helper.call('getCapabilities', {})
        if capabilities['sessionLocked'] is not False:
            raise RuntimeError('Unlock the macOS console session before running this interactive check')
        if capabilities['permissions'] != {'accessibility': True, 'screenRecording': True}:
            raise RuntimeError('Accessibility and Screen Recording grants are required')
        with tempfile.TemporaryDirectory(prefix='dsh-cua-axless-') as directory:
            root = Path(directory)
            state_path = root / 'state.json'
            def app_binary(name, state_file):
                contents = root / (name + '.app') / 'Contents'
                (contents / 'MacOS').mkdir(parents=True)
                (contents / 'Info.plist').write_bytes(plistlib.dumps({
                    'CFBundleIdentifier': 'org.deepseek-harness.cua.' + root.name + '.' + name,
                    'CFBundleExecutable': 'fixture', 'CFBundleName': name, 'CFBundlePackageType': 'APPL',
                    'DSHFixtureStatePath': str(state_file),
                }))
                return contents / 'MacOS/fixture'

            binary = app_binary('Target', state_path)
            subprocess.run(['swiftc', str(ROOT / 'tests/AxlessFixture.swift'), '-o', str(binary)], check=True)
            pending = helper.call('getApp', {'selector': str(binary.parents[2])})
            fixture = helper.call('launchApp', {'appHandle': pending['appHandle']})['pid']
            try:

                def wait_state(predicate, description):
                    deadline = time.monotonic() + 5
                    while True:
                        state = json.loads(state_path.read_text()) if state_path.exists() else {}
                        if state:
                            assert state['pid'] == fixture
                            if predicate(state):
                                return state
                        if time.monotonic() >= deadline:
                            raise AssertionError(description + ': ' + json.dumps(state))
                        time.sleep(0.025)

                actual = wait_state(lambda state: not state['hiddenAX'], 'fixture did not initialize')
                app = helper.call('getApp', {'selector': str(fixture)})
                owner = {'appHandle': app['appHandle']}
                window_id = actual['windowId']
                params = {**owner, 'windowId': window_id, 'maxElements': 100, 'maxDepth': 15}
                helper.call('click', {**owner, 'windowId': window_id, 'x': 1, 'y': 1}, 'STALE_SNAPSHOT')
                first = helper.call('getState', params)
                buttons = [element for element in first['elements'] if element['title'] == 'Increment AXless fixture']
                assert len(buttons) == 1, first
                old_index = {**owner, 'snapshotId': first['snapshotId'], 'elementIndex': buttons[0]['index']}
                os.kill(fixture, signal.SIGUSR1)
                actual = wait_state(lambda state: state['hiddenAX'], 'fixture did not remove its AX roots')
                empty = helper.call('getState', params)
                assert empty['tree'] == '' and empty['elements'] == [] and empty['truncated'] is False, empty
                assert empty['snapshotId'] != first['snapshotId']
                helper.call('click', old_index, 'STALE_SNAPSHOT')
                helper.call('click', {**owner, 'snapshotId': empty['snapshotId'], 'elementIndex': 0}, 'INVALID_ARGUMENT')
                capture = helper.call('screenshot', {**owner, 'windowId': window_id})
                assert base64.b64decode(capture['data'], validate=True).startswith(b'\x89PNG\r\n\x1a\n')
                x, y = actual['buttonPoint']
                helper.call('click', {**owner, 'windowId': window_id, 'snapshotId': empty['snapshotId'], 'x': x, 'y': y})
                wait_state(lambda state: state['count'] == 1, 'AXless coordinate click did not reach the native button exactly once')
                os.kill(fixture, signal.SIGUSR2)
                wait_state(lambda state: not state['hiddenAX'], 'fixture did not restore AX')
                recovered = helper.call('getState', params)
                assert 'Increment AXless fixture' in recovered['tree']
                helper.call('click', {**owner, 'windowId': window_id, 'snapshotId': empty['snapshotId'], 'x': x, 'y': y}, 'STALE_SNAPSHOT')

                os.kill(fixture, signal.SIGWINCH)
                actual = wait_state(lambda state: state['resizeCount'] == 1, 'fixture did not resize')
                for snapshot in [{}, {'snapshotId': recovered['snapshotId']}]:
                    target = {**owner, 'windowId': window_id, **snapshot}
                    helper.call('hover', {**target, 'x': x, 'y': y}, 'WINDOW_CHANGED')
                    helper.call('click', {**target, 'x': x, 'y': y}, 'WINDOW_CHANGED')
                    helper.call('scroll', {**target, 'x': x, 'y': y, 'deltaLinesY': -1}, 'WINDOW_CHANGED')
                    helper.call('drag', {**target, 'fromX': x, 'fromY': y, 'toX': x + 1, 'toY': y,
                                         'durationMs': 100, 'steps': 2}, 'WINDOW_CHANGED')
                assert json.loads(state_path.read_text())['count'] == 1
                helper.call('getState', params)
                x, y = actual['buttonPoint']
                helper.call('click', {**owner, 'windowId': window_id, 'x': x, 'y': y})
                wait_state(lambda state: state['count'] == 2, 'fresh AX did not admit resized-window input')

                os.kill(fixture, signal.SIGURG)
                wait_state(lambda state: state['moved'], 'fixture did not move')
                helper.call('click', {**owner, 'windowId': window_id, 'x': x, 'y': y})
                wait_state(lambda state: state['count'] == 3, 'window movement invalidated local coordinates')

                os.kill(fixture, signal.SIGWINCH)
                actual = wait_state(lambda state: state['resizeCount'] == 2, 'fixture did not resize again')
                helper.call('screenshot', {**owner, 'windowId': window_id})
                x, y = actual['buttonPoint']
                helper.call('click', {**owner, 'windowId': window_id, 'x': x, 'y': y})
                wait_state(lambda state: state['count'] == 4, 'fresh screenshot did not admit resized-window input')

                # Restoration uses an app whose AX roots have never been replaced by the AXless fixture.
                stop_application(fixture)
                fixture = None
                original_binary = binary
                state_path = root / 'restoration.json'
                binary = app_binary('Restoration', state_path)
                shutil.copy2(original_binary, binary)
                pending = helper.call('getApp', {'selector': str(binary.parents[2])})
                fixture = helper.call('launchApp', {'appHandle': pending['appHandle']})['pid']
                actual = wait_state(lambda state: bool(state.get('windowId')), 'restoration fixture did not initialize')
                owner = {'appHandle': pending['appHandle']}
                window_id = actual['windowId']

                foreground_path = root / 'foreground.json'
                foreground_binary = app_binary('Foreground', foreground_path)
                shutil.copy2(binary, foreground_binary)
                pending_foreground = helper.call('getApp', {'selector': str(foreground_binary.parents[2])})
                foreground = helper.call('launchApp', {'appHandle': pending_foreground['appHandle']})['pid']
                subprocess.run(['open', '-a', str(foreground_binary.parents[2])], check=True)
                wait_state(lambda state: foreground_path.exists() and json.loads(foreground_path.read_text()).get('active')
                           and not state['active'], 'foreground fixture did not take focus')
                for number, key, target in [(signal.SIGALRM, 'hidden', owner),
                                            (signal.SIGHUP, 'minimized', {**owner, 'windowId': window_id})]:
                    if key == 'minimized':
                        subprocess.run(['open', '-a', str(binary.parents[2])], check=True)
                        wait_state(lambda state: state['active'], 'target fixture did not activate for minimization')
                    os.kill(fixture, number)
                    wait_state(lambda state: state[key], 'fixture did not ' + key)
                    subprocess.run(['open', '-a', str(foreground_binary.parents[2])], check=True)
                    wait_state(lambda state: json.loads(foreground_path.read_text())['active'] and not state['active'],
                               'foreground fixture did not regain focus before restoration')
                    restored = helper.call('show', target)
                    actual = wait_state(lambda state: not state[key], 'show did not restore ' + key)
                    assert restored['windowId'] == window_id, restored
                    assert restored['dispatched'] and not restored['verified'], restored
                    assert restored['foregroundChanged'] is False, restored
                    assert not actual['active'] and json.loads(foreground_path.read_text())['active']
                helper.call('show', {**owner, 'windowId': json.loads(foreground_path.read_text())['windowId']}, 'WINDOW_UNAVAILABLE')
                helper.eof()
                print('PASS: AXless input, resize guards, fresh observation, movement and background unhide/unminimize')
            finally:
                run_cleanup(lambda: stop_application(foreground) if foreground is not None else None,
                            lambda: stop_application(fixture))
                fixture = None
                foreground = None
    finally:
        run_cleanup(lambda: stop_application(foreground) if foreground is not None else None,
                    lambda: stop_application(fixture) if fixture is not None else None,
                    helper.stop)


if __name__ == '__main__':
    main()
