"""Compare listActions with direct AX reads and invoke duplicate-label actions on an owned AppKit fixture."""
import argparse
import json
from contextlib import ExitStack
from pathlib import Path
import subprocess
import tempfile

from native_test_support import ROOT, NativeHelper, line, stop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, help='Existing native helper executable')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='dsh-action-inventory-') as directory, ExitStack() as cleanup:
        binary = Path(directory) / 'fixture'
        state = Path(directory) / 'callback.txt'
        subprocess.run(['swiftc', str(ROOT / 'tests/ActionInventoryFixture.swift'), '-o', str(binary)], check=True)
        fixture = subprocess.Popen([str(binary), str(state)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        cleanup.callback(fixture.stdin.close)
        cleanup.callback(fixture.stdout.close)
        cleanup.callback(stop, fixture)
        assert line(fixture).strip() == 'READY'

        helper = NativeHelper([], args.helper)
        cleanup.callback(helper.stop)
        owner = {'appHandle': helper.call('getApp', {'selector': str(fixture.pid)})['appHandle']}
        window = next(w for w in helper.call('listWindows', owner) if w['title'] == 'Action inventory')
        scope = {**owner, 'windowId': window['windowId']}
        observed = helper.call('getState', {**scope, 'maxElements': 100, 'maxDepth': 12, 'details': True})
        fixture.stdin.write('observe\n')
        fixture.stdin.flush()
        inventory = json.loads(line(fixture))
        assert set(inventory) == {'audit-window', 'audit-custom', 'audit-disabled', 'audit-field', 'audit-slider'}, inventory
        for identifier, expected in sorted(inventory.items()):
            element = next(e for e in observed['elements'] if e['identifier'] == identifier)
            target = {**scope, 'snapshotId': observed['snapshotId'], 'elementId': element['elementId']}
            names = helper.call('listActions', target)
            details = helper.call('listActions', {**target, 'details': True})
            rows = details['actions']
            assert [row['name'] for row in rows] == names, (identifier, rows, names)
            native = [row for row in rows if row['kind'] == 'native']
            assert [{'name': r['name'], 'description': r['description']} for r in native] == expected['native'], identifier
            setters = {r['attribute']: r for r in rows if r['kind'] == 'setAttribute'}
            assert set(setters) == set(expected['writable']), (identifier, setters, expected)
            assert all(row['name'] == f"{element['role']}.{key}.Set" for key, row in setters.items())
            assert set(details['unknownWritability']) == set(expected['unknown']), identifier
            if identifier == 'audit-custom':
                assert details['defaultAction'] == 'AXPress'
                marked = [row['name'] for row in native if row['description'] == 'Mark']
                assert len(set(marked)) == len(marked) == 2, native
                callbacks = []
                for name in marked:
                    assert helper.call('performAction', {**target, 'action': name})['dispatched']
                    callbacks.append(state.read_text())
                assert set(callbacks) == {'first', 'second'}, callbacks
            if identifier == 'audit-disabled':
                assert details['enabled'] is False
            if identifier == 'audit-field':
                assert setters['AXValue']['argument']['type'] == 'string'
                assert setters['AXSelectedTextRange']['argument']['required'] == ['location', 'length']
                assert 'fixture contents' not in json.dumps(details)
            if identifier == 'audit-slider':
                argument = setters['AXValue']['argument']
                assert (argument['type'], argument['minimum'], argument['maximum']) == ('number', 0, 10), argument
            print(f"{identifier}: {len(native)} native actions, {len(setters)} setters, {len(expected['unknown'])} unknown")


if __name__ == '__main__':
    main()
