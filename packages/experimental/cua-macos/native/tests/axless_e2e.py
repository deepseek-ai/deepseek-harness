"""Opt-in AX-present -> AXless -> AX-present window regression; requires an unlocked Mac.

Build the helper first. This runner compiles only its owned AppKit fixture,
changes no system permission settings, and controls no user applications.
"""
import argparse
import base64
from contextlib import ExitStack
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
from capabilities_e2e import stop_application, wait_for_state


def focus_fixture(helper, app, path, ready=lambda: True):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        helper.call('activate', app)
        first = wait_for_state(path, lambda s: s['active'] and s['key'])
        since = time.monotonic()
        while time.monotonic() - since < 1:
            state = json.loads(path.read_text())
            if not state['key'] or state['keyLosses'] != first['keyLosses']:
                break
            time.sleep(0.025)
        else:
            if ready():
                return state
    raise AssertionError(f'could not establish keyboard focus for {path.stem}')


def check_stage_groups(helper, make_bundle, executable, root):
    def launch(name, owned):
        path = root / (name + '.json')
        binary = make_bundle(name, path, stage_participant=True)
        shutil.copy2(executable, binary)
        handle = helper.call('getApp', {'selector': str(binary.parents[2])})['appHandle']
        app = {'appHandle': handle}
        helper.call('launchApp', app)
        state = wait_for_state(path, lambda s: bool(s.get('windowId')))
        owned.callback(stop_application, state['pid'])
        return app, path, state['windowId']

    def expanded(binding):
        app, path, window_id = binding
        state = json.loads(path.read_text())
        window = next(w for w in helper.call('listWindows', app) if w['windowId'] == window_id)
        return window['isOnScreen'] and all(abs(window['bounds'][k] - actual) <= 1
                                            for k, actual in zip(('width', 'height'), state['size']))

    def focus(binding):
        app, path, _ = binding
        return focus_fixture(helper, app, path, lambda: expanded(binding))


    for name, explicit in [('StageApp', False), ('StageWindow', True)]:
        with ExitStack() as owned:
            front = launch(name + 'Front', owned)
            target = launch(name, owned)
            app, path, window_id = target
            focus(target)
            focus(front)
            # Stage Manager keeps the thumbnail on screen even after the normal window leaves the stage.
            wait_for_state(path, lambda s: not s['minimized'] and not s['active'] and not expanded(target))
            assert next(w for w in helper.call('listWindows', app) if w['windowId'] == window_id)['isOnScreen']
            params = {**app, 'windowId': window_id} if explicit else app
            result = helper.call('show', params)
            assert result == {'windowId': window_id, 'dispatched': True, 'foregroundChanged': False}, result
            wait_for_state(front[1], lambda s: s['active'] and s['keySettled'] and expanded(front) and expanded(target))
            assert not json.loads(path.read_text())['minimized']
            assert helper.call('show', params) == {**result, 'dispatched': False}
            print(f'PASS: {name} joined the current stage at full size; original window kept keyboard focus')


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
            def app_binary(name, state_file, stage_participant=False, reopen_delay=0):
                contents = root / (name + '.app') / 'Contents'
                (contents / 'MacOS').mkdir(parents=True)
                (contents / 'Info.plist').write_bytes(plistlib.dumps({
                    'CFBundleIdentifier': 'org.deepseek-harness.cua.' + root.name + '.' + name,
                    'CFBundleExecutable': 'fixture', 'CFBundleName': name, 'CFBundlePackageType': 'APPL',
                    'DSHFixtureStatePath': str(state_file), 'DSHStageParticipant': stage_participant,
                    'DSHReopenDelay': reopen_delay,
                }))
                return contents / 'MacOS/fixture'

            binary = app_binary('Target', state_path)
            subprocess.run(['swiftc', str(ROOT / 'tests/AxlessFixture.swift'), '-o', str(binary)], check=True)
            pending = helper.call('getApp', {'selector': str(binary.parents[2])})
            launched = helper.call('launchApp', {'appHandle': pending['appHandle']})
            assert launched['running'] is True, launched
            fixture = wait_for_state(state_path, lambda state: state['pid'] > 0)['pid']
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
                old_index = {**owner, 'snapshotId': first['snapshotId'], 'elementId': buttons[0]['elementId']}
                os.kill(fixture, signal.SIGUSR1)
                actual = wait_state(lambda state: state['hiddenAX'], 'fixture did not remove its AX roots')
                empty = helper.call('getState', params)
                assert empty['tree'] == '' and empty['elements'] == [] and empty['truncated'] is False, empty
                assert empty['snapshotId'] != first['snapshotId']
                helper.call('click', old_index, 'STALE_SNAPSHOT')
                helper.call('click', {**owner, 'snapshotId': empty['snapshotId'], 'elementId': '0'}, 'INVALID_ARGUMENT')
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
                    helper.call('mouseMove', {**target, 'x': x, 'y': y}, 'WINDOW_CHANGED')
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
                binary = app_binary('Restoration', state_path, reopen_delay=2)
                shutil.copy2(original_binary, binary)
                pending = helper.call('getApp', {'selector': str(binary.parents[2])})
                launched = helper.call('launchApp', {'appHandle': pending['appHandle']})
                assert launched['running'] is True, launched
                fixture = wait_for_state(state_path, lambda state: state['pid'] > 0)['pid']
                actual = wait_state(lambda state: bool(state.get('windowId')), 'restoration fixture did not initialize')
                owner = {'appHandle': pending['appHandle']}
                window_id = actual['windowId']

                foreground_path = root / 'foreground.json'
                foreground_binary = app_binary('Foreground', foreground_path)
                shutil.copy2(binary, foreground_binary)
                pending_foreground = helper.call('getApp', {'selector': str(foreground_binary.parents[2])})
                launched = helper.call('launchApp', {'appHandle': pending_foreground['appHandle']})
                assert launched['running'] is True, launched
                foreground = wait_for_state(foreground_path, lambda state: state['pid'] > 0)['pid']
                front_owner = {'appHandle': pending_foreground['appHandle']}
                target = {**owner, 'windowId': window_id}

                def focus_foreground():
                    return focus_fixture(helper, front_owner, foreground_path)

                def check_show(before, selected, status):
                    result = helper.call('show', selected)
                    after = wait_for_state(foreground_path, lambda s: s['active'] and s['key'])
                    assert result == {'dispatched': status == 'restored', 'windowId': window_id, 'foregroundChanged': False}, (result, before, after)
                    if status != 'restored':
                        assert after['keyLosses'] == before['keyLosses'], after
                    return after

                before = focus_foreground()
                check_show(before, target, 'already_visible')
                os.kill(fixture, signal.SIGALRM)
                wait_state(lambda s: s['hidden'], 'fixture did not hide')
                check_show(before, owner, 'restored')
                wait_state(lambda s: not s['hidden'], 'hidden application remained hidden')

                helper.call('activate', owner)
                wait_state(lambda s: s['active'] and s['key'], 'target did not regain keyboard focus')
                os.kill(fixture, signal.SIGHUP)
                state = wait_state(lambda s: s['minimizeRequested'] and (s['minimized'] or not s['active']),
                                   'target did not minimize or leave the active Stage Manager group')
                before = focus_foreground()
                # With Stage Manager a minimize request can just move the window to the strip.
                # The ordinary-window pairs below cover that transition in their own stages.
                if state['minimized']:
                    foreground_after = check_show(before, owner, 'restored')
                    after = wait_state(lambda s: not s['minimized'], 'target remained minimized')
                    assert after['size'] == state['size'], after
                    check_show(foreground_after, target, 'already_visible')
                    os.kill(fixture, signal.SIGXCPU)
                    wait_state(lambda s: s['focusOnRestore'], 'target did not arm foreground restoration')
                    helper.call('activate', owner)
                    wait_state(lambda s: s['active'] and s['key'], 'target did not gain focus')
                    os.kill(fixture, signal.SIGHUP)
                    wait_state(lambda s: s['minimized'], 'target did not minimize')
                    before = focus_foreground()
                    after = check_show(before, target, 'restored')
                    assert after['keyLosses'] > before['keyLosses'], 'target did not exercise the focus handoff'
                helper.call('show', {**owner, 'windowId': json.loads(foreground_path.read_text())['windowId']}, 'WINDOW_UNAVAILABLE')
                before_close = json.loads(state_path.read_text())['reopened']
                os.kill(fixture, signal.SIGINFO)
                wait_state(lambda s: s['closed'], 'target did not close its main window')
                focus_foreground()
                stale = helper.call('show', target, 'WINDOW_UNAVAILABLE')
                assert 'app.show()' in stale['message'], stale
                closed = json.loads(state_path.read_text())
                assert closed['closed'] and closed['reopened'] == before_close, closed
                # The app responds to AX reads while it waits two seconds to create the replacement window.
                with ExitStack() as clients:
                    short_ax = NativeHelper([], args.helper, '--ax-timeout-ms', '1000', '--timeout-ms', '10000')
                    clients.callback(short_ax.stop)
                    selection = short_ax.call('getApp', {'selector': str(fixture)})
                    opened = short_ax.call('show', {'appHandle': selection['appHandle']})
                new = wait_state(lambda s: not s['closed'] and s.get('windowId') != window_id,
                                 'reopen did not replace the closed window')
                assert opened == {'dispatched': True,
                                  'windowId': new['windowId'], 'foregroundChanged': False}, opened
                assert new['reopened'] == before_close + 1 and new['pid'] == fixture, new
                wait_for_state(foreground_path, lambda s: s['active'] and s['key'])
                assert helper.call('show', owner) == {'dispatched': False, 'windowId': new['windowId'], 'foregroundChanged': False}
                helper.call('show', target, 'WINDOW_UNAVAILABLE')
                assert json.loads(state_path.read_text())['reopened'] == new['reopened']
            finally:
                run_cleanup(lambda: stop_application(foreground) if foreground is not None else None,
                            lambda: stop_application(fixture))
                fixture = None
                foreground = None
            stage = subprocess.run(['defaults', 'read', 'com.apple.WindowManager', 'GloballyEnabled'],
                                   capture_output=True, text=True)
            if stage.stdout.strip() == '1':
                check_stage_groups(helper, app_binary, binary, root)
            helper.eof()
            print('PASS: AXless input, resize guards, fresh observation, movement and focus-preserving show')
    finally:
        run_cleanup(lambda: stop_application(foreground) if foreground is not None else None,
                    lambda: stop_application(fixture) if fixture is not None else None,
                    helper.stop)


if __name__ == '__main__':
    main()
