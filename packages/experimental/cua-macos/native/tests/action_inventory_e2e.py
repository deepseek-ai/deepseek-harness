"""Compare listActions with direct AX reads and use getActionSchema to operate the listed controls."""
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
        assert set(inventory) == {'audit-window', 'audit-custom', 'audit-disabled', 'audit-field', 'audit-slider', 'audit-editor', 'audit-check', 'audit-stepper'}, inventory
        for identifier, expected in sorted(inventory.items()):
            element = next(e for e in observed['elements'] if e['identifier'] == identifier)
            target = {**scope, 'snapshotId': observed['snapshotId'], 'elementId': element['elementId']}
            names = helper.call('listActions', target)
            native = [entry['name'] for entry in expected['native']]
            unsupported = set(expected['arrays']) - {'AXSelectedTextRanges'}
            setters = {attr: f"{element['role']}.{attr}.Set" for attr in expected['writable'] if attr not in unsupported}
            assert names == native + list(setters.values()), (identifier, names, expected)
            schemas = {name: helper.call('getActionSchema', {'action': name}) for name in names}
            for name, schema in schemas.items():
                assert schema['required'] == ([] if name in native else ['argument']), (name, schema)
                if name in native:
                    assert schema['properties']['argument']['type'] == 'null', (name, schema)
            if identifier == 'audit-custom':
                marked = [entry['name'] for entry in expected['native'] if entry['description'] == 'Mark']
                assert len(set(marked)) == len(marked) == 2, marked
                callbacks = []
                for name in marked:
                    assert helper.call('performAction', {**target, 'action': name})['dispatched']
                    callbacks.append(state.read_text())
                assert set(callbacks) == {'first', 'second'}, callbacks
            if identifier == 'audit-field':
                assert schemas[setters['AXFocused']]['properties']['argument']['type'] == 'boolean'
                assert schemas[setters['AXSelectedText']]['properties']['argument']['type'] == 'string'
                assert schemas[setters['AXVisibleCharacterRange']]['properties']['argument']['required'] == ['location', 'length']
            if identifier in {'audit-field', 'audit-editor'}:
                assert schemas[setters['AXValue']]['properties']['argument']['type'] == 'string'
            if identifier == 'audit-editor':
                name = setters['AXSelectedTextRanges']
                argument_schema = schemas[name]['properties']['argument']
                assert argument_schema['type'] == 'array' and argument_schema['items']['required'] == ['location', 'length']
                selected = [{'location': 0, 'length': 2}, {'location': 6, 'length': 3}]
                assert helper.call('performAction', {**target, 'action': name, 'argument': selected})['dispatched']
                helper.call('performAction', {**target, 'action': name, 'argument': selected[::-1]}, 'INVALID_ARGUMENT')
                fixture.stdin.write('selections\n')
                fixture.stdin.flush()
                assert json.loads(line(fixture)) == [[0, 2], [6, 3]]
            if identifier == 'audit-slider':
                name = setters['AXValue']
                assert {item['type'] for item in schemas[name]['properties']['argument']['oneOf']} == {'number', 'string'}
                assert helper.call('performAction', {**target, 'action': name, 'argument': 7})['dispatched']
            print(f"{identifier}: {len(native)} native actions, {len(setters)} setters, excluded arrays: {sorted(unsupported)}")
        refreshed = helper.call('getState', {**scope, 'maxElements': 100, 'maxDepth': 12, 'details': True})
        slider = next(item for item in refreshed['elements'] if item['identifier'] == 'audit-slider')
        assert float(slider['value']) == 7, slider['value']


if __name__ == '__main__':
    main()
