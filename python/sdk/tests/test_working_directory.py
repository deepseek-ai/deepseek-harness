from __future__ import annotations

import sys
from pathlib import Path

import pytest

from pydantic import ValidationError

from deepseek_harness import DeepSeekHarness


def test_session_directories_are_independent_and_relative_paths_stay_on_the_wire(tmp_path: Path) -> None:
    runtime = tmp_path / "directory_runtime.py"
    runtime.write_text(
        """
import json
import os
import sys

directories = {}
origin = None
for line in sys.stdin:
    frame = json.loads(line)
    method = frame['method']
    params = frame.get('params') or {}
    if method == 'initialize':
        origin = params['cwd']
        result = {'serverInfo': {'name': 'directory-runtime', 'version': '1'}}
    elif method == 'shutdown':
        print(json.dumps({'jsonrpc': '2.0', 'id': frame['id'], 'result': {}}), flush=True)
        break
    elif method == 'session/working-directory/get':
        result = {'cwd': directories.get(params['sessionId'], origin)}
    elif method == 'session/working-directory/set':
        assert not os.path.isabs(params['path']), 'client must preserve relative paths'
        previous = directories.get(params['sessionId'], origin)
        current = os.path.normpath(os.path.join(previous, params['path']))
        directories[params['sessionId']] = current
        result = {'cwd': 7 if params['path'] == 'malformed' else current}
    else:
        raise AssertionError(method)
    print(json.dumps({'jsonrpc': '2.0', 'id': frame['id'], 'result': result}), flush=True)
""".strip()
    )
    with DeepSeekHarness(cwd=str(tmp_path), _launch_args=(sys.executable, str(runtime))) as harness:
        first = harness.start_session("first")
        second = harness.start_session("second")
        assert first.get_working_directory() == str(tmp_path)
        assert first.set_working_directory("child") == str(tmp_path / "child")
        assert first.get_working_directory() == str(tmp_path / "child")
        assert second.get_working_directory() == str(tmp_path)
        with pytest.raises(ValidationError):
            second.set_working_directory("malformed")
