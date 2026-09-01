#!/usr/bin/env python3
"""Keyless full-turn and snapshot smoke for the Python SDK runtime."""

from __future__ import annotations

import argparse
import difflib
import importlib
import importlib.metadata
import json
import os
import queue
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from deepseek_harness import RunResult


EXPECTED_TEXT = "runtime smoke ok"
LIVE_API_SENTINEL = "PYTHON_SDK_LIVE_OK"
CODE_PROMPT = "Use run_code to compute the packaged worker smoke value."
CODE_WORKER_TEXT = "code worker smoke ok"
WORKFLOW_PROMPT = "Use workflow to compute the packaged worker smoke value without agents."
WORKFLOW_WORKER_TEXT = "workflow worker smoke ok"
MINIMAL_PROMPT = "Exercise the packaged minimal agent's persistent shell and string-replacement editor."
MINIMAL_TEXT = "minimal agent smoke ok"
MINIMAL_EDITOR_PATH_PREFIX = "Editor path: "
FS_SEARCH_PROMPT = "Exercise the packaged filesystem search tools."
FS_SEARCH_TEXT = "filesystem search smoke ok"
FS_SEARCH_MARKER = "PACKAGED_FS_SEARCH_OK"
MCP_PROMPT = "Exercise the packaged MCP client with one external stdio server."
MCP_TEXT = "MCP client smoke ok"
PROFILE_PLUGIN_PROMPT = "Verify the Python-installed dsh profile plugin."
PROFILE_PLUGIN_TEXT = "profile plugin smoke ok"
PROFILE_PLUGIN_MARKER = "PYTHON_INSTALLED_DSH_PROFILE_PLUGIN"
IS_WINDOWS = sys.platform == "win32"
MINIMAL_SHELL_TOOL = "pwsh" if IS_WINDOWS else "bash"
MINIMAL_SHELL_COMMAND = (
    "$global:dshSdkCounter = [int]$global:dshSdkCounter + 1; "
    'Write-Output "COUNT=$global:dshSdkCounter CWD=$((Get-Location).Path)"; '
    "if ($global:dshSdkCounter -eq 1) { Set-Location $env:TEMP }"
    if IS_WINDOWS
    else (
        "counter=$(( ${counter:-0} + 1 )); export counter; "
        "printf 'COUNT=%s CWD=%s\\n' \"$counter\" \"$PWD\"; "
        "if [ \"$counter\" -eq 1 ]; then cd /tmp; fi"
    )
)
MINIMAL_SHELL_SECOND_CWD = str(Path(tempfile.gettempdir()).resolve()) if IS_WINDOWS else "/tmp"
LEGACY_CUSTOM_DISABLED_ROWS = (
    "agent-instructions",
    "goal",
    "goal-round-driver",
    "command-goal",
    "plan-mode",
    "skill",
    "skill-filesystem",
    "tool-fs",
    "tool-fs-search",
    "tool-goal",
    "tool-ralph",
    "tool-skill",
    "tool-str-replace-editor",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent-fork",
    "tool-todo",
    "tool-web",
)
SNAPSHOT_PROMPT = "Run the advanced packaged-runtime snapshot scenario."
SNAPSHOT_SESSION_ID = "advanced-executable"
SNAPSHOT_DIRECT_CHILD_PROMPT = "Reply with exactly DIRECT_CHILD_OK and nothing else."
SNAPSHOT_WORKFLOW_CHILD_PROMPT = "Reply with exactly WORKFLOW_CHILD_OK and nothing else."
SNAPSHOT_FINAL_TEXT = "ADVANCED_EXECUTABLE_OK"
RESTART_FIRST_PROMPT = "Complete the first isolated Python SDK process turn."
RESTART_FIRST_TEXT = "PROCESS_ONE_OK"
RESTART_SECOND_PROMPT = "Complete the second isolated Python SDK process turn."
RESTART_SECOND_TEXT = "PROCESS_TWO_OK"
RESTART_FIRST_SESSION_ID = "process-one"
RESTART_SECOND_SESSION_ID = "process-two"
SNAPSHOT_PLUGIN_CODE = """\
return (ctx) => {
  harness.registerTool(ctx, harness.defineTool({
    name: 'snapshot_double',
    description: 'Double a number for executable snapshot verification.',
    parameters: { value: { type: 'number', required: true } },
    output: {
      schema: { type: 'number' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      }
    },
    async execute(args) {
      return args.value * 2
    }
  }))
}
"""
SNAPSHOT_WORKFLOW_SCRIPT = (
    "phase('Delegate')\n"
    f"const reply = await agent('{SNAPSHOT_WORKFLOW_CHILD_PROMPT}', {{ label: 'workflow-child' }})\n"
    "return { reply }"
)
ADVANCED_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "advanced"
)
ADVANCED_SNAPSHOT_FILENAMES = ("result.json", "session.jsonl", "session.1.jsonl", "session.2.jsonl")
MINIMAL_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "minimal"
)
if IS_WINDOWS:
    MINIMAL_SNAPSHOT_DIRECTORY /= "win-x64"
MINIMAL_SNAPSHOT_FILENAMES = ("model-visible.json",)
RESTART_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "restart"
)
RESTART_SNAPSHOT_FILENAMES = ("result.json", "requests.json", "session.1.jsonl", "session.2.jsonl")
MCP_SERVER_SCRIPT = """\
import json
import os
import sys
import time


log_path = os.environ.get("MCP_SMOKE_LOG")


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\\n")
    sys.stdout.flush()


for line in sys.stdin:
    request = json.loads(line)
    if log_path is not None:
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(str(request.get("method")) + "\\n")
    request_id = request.get("id")
    if request_id is None:
        continue
    method = request.get("method")
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "python-wheel-fixture", "version": "1.0.0"},
            },
        })
    elif method == "tools/list":
        # Keep discovery pending long enough that an SDK runtime answering
        # initialize before discovery completes makes its first model request
        # without this tool and fails deterministically.
        time.sleep(0.25)
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [{
                    "name": "add",
                    "description": "Add two numbers.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                        "required": ["a", "b"],
                        "additionalProperties": False,
                    },
                }],
            },
        })
    elif method == "tools/call":
        params = request["params"]
        if params.get("name") != "add" or params.get("arguments") != {"a": 19, "b": 23}:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32602, "message": "unexpected tool call"},
            })
            continue
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": "42"}]},
        })
    else:
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"unsupported method: {method}"},
        })
"""


def write_profile_patch(
    root: Path,
    name: str,
    sessions: Path,
    patches: list[dict[str, object]],
) -> Path:
    """Write one JSON-form dsh profile patch with deterministic persistence."""
    path = root / name
    path.write_text(json.dumps([
        {
            "id": "session-persistence-jsonl",
            "config": {"root": str(sessions), "compression": "none"},
        },
        {"id": "session-telemetry-otel", "disabled": True},
        *patches,
    ], indent=2))
    return path


def write_advanced_profile_patch(root: Path, name: str, sessions: Path) -> Path:
    """Write the shared custom, snapshot, and restart profile patch."""
    return write_profile_patch(root, name, sessions, [
        {"id": "tools", "config": {"mode": "both"}},
        {
            "id": "system-prompt",
            "config": {
                "persona": "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
            },
        },
        {"id": "session-log-deepseek", "config": {"enabled": True}},
        *({"id": row_id, "disabled": True} for row_id in LEGACY_CUSTOM_DISABLED_ROWS),
        {"id": "tool-bash", "disabled": True},
        {"id": "tool-pwsh", "disabled": True},
        {
            "id": "tool-subagent",
            "config": {
                "provider": "spawn",
                "toolName": "subagent",
                "backgroundMode": "one-shot",
            },
        },
        {"insert": [
            {"id": "code-runtime", "name": "@deepseek-ai/dsh-code-runtime-worker-thread"},
            {"id": "cordis-host-runner", "name": "@deepseek-ai/dsh-cordis-host-runner"},
            {"id": "cordis-tool", "name": "@deepseek-ai/dsh-tool-cordis"},
        ]},
    ])


def write_mcp_patch(root: Path, sessions: Path, server_script: Path) -> Path:
    """Write a profile patch that mounts the packaged MCP client."""
    return write_profile_patch(root, "mcp.patch.yml", sessions, [{
        "insert": [{
            "id": "mcp-fixture",
            "name": "@deepseek-ai/dsh-mcp-client",
            "config": {
                "serverName": "fixture",
                "transport": "stdio",
                "command": sys.executable,
                "args": [str(server_script)],
                "env": {"MCP_SMOKE_LOG": str(server_script.with_suffix(".log"))},
                "failOnStartupError": True,
                "reconnect": {"enabled": False},
            },
        }],
    }])


class MockModelHandler(BaseHTTPRequestHandler):
    """Return deterministic text, worker, and orchestration completions."""

    requests: list[dict[str, object]] = []

    def do_POST(self) -> None:
        content_length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(content_length))
        self.requests.append(body)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        chunks = completion_chunks(body)
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, _format: str, *_args: object) -> None:
        return


def completion_chunks(body: dict[str, object]) -> list[dict[str, object]]:
    """Choose the next deterministic model response from request history."""
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AssertionError(f"model request has no messages: {body}")
    latest = messages[-1]
    if not isinstance(latest, dict):
        raise AssertionError(f"model request has an invalid latest message: {body}")

    if latest.get("role") == "tool":
        call_id, tool_name = latest_tool_call(messages)
        tool_text = message_text(latest.get("content"))
        mcp = mcp_tool_followup(call_id, tool_name, tool_text)
        if mcp is not None:
            return mcp
        fs_search = fs_search_tool_followup(call_id, tool_name, tool_text)
        if fs_search is not None:
            return fs_search
        minimal = minimal_tool_followup(body, call_id, tool_name, tool_text)
        if minimal is not None:
            return minimal
        advanced = advanced_tool_followup(body, call_id, tool_name, tool_text)
        if advanced is not None:
            return advanced
        if "42" not in tool_text:
            raise AssertionError(f"{tool_name} worker returned no expected value: {latest}")
        if tool_name == "run_code":
            return text_chunks(CODE_WORKER_TEXT)
        if tool_name == "workflow":
            return text_chunks(WORKFLOW_WORKER_TEXT)
        raise AssertionError(f"unexpected tool follow-up: {tool_name}")

    user_prompts = [
        message_text(message.get("content"))
        for message in reversed(messages)
        if isinstance(message, dict) and message.get("role") == "user"
    ]
    minimal_prompt = next(
        (
            prompt
            for prompt in user_prompts
            if prompt.startswith(f"{MINIMAL_PROMPT}\n{MINIMAL_EDITOR_PATH_PREFIX}")
        ),
        None,
    )
    # The minimal composition's assembled system prompt, advertised tool schemas, and
    # model-visible messages are pinned by its snapshot, not asserted here.
    if minimal_prompt is not None:
        return tool_call_chunks(
            "minimal-bash-1",
            MINIMAL_SHELL_TOOL,
            {"command": MINIMAL_SHELL_COMMAND},
        )
    scenario_prompts = {
        SNAPSHOT_DIRECT_CHILD_PROMPT,
        SNAPSHOT_WORKFLOW_CHILD_PROMPT,
        SNAPSHOT_PROMPT,
        CODE_PROMPT,
        WORKFLOW_PROMPT,
        FS_SEARCH_PROMPT,
        MCP_PROMPT,
        RESTART_FIRST_PROMPT,
        RESTART_SECOND_PROMPT,
        PROFILE_PLUGIN_PROMPT,
    }
    prompt = next(
        (candidate for candidate in user_prompts if candidate in scenario_prompts),
        message_text(latest.get("content")),
    )
    if prompt == SNAPSHOT_DIRECT_CHILD_PROMPT:
        return text_chunks("DIRECT_CHILD_OK")
    if prompt == SNAPSHOT_WORKFLOW_CHILD_PROMPT:
        return text_chunks("WORKFLOW_CHILD_OK")
    if prompt == SNAPSHOT_PROMPT:
        assert_advertised_tool(body, "cordis_define")
        return tool_call_chunks(
            "advanced-define",
            "cordis_define",
            {
                "plugin": {"kind": "new", "idPrefix": "snap"},
                "name": "Snapshot Double",
                "purpose": "Expose a deterministic doubling tool for executable snapshot verification.",
                "code": {"host": SNAPSHOT_PLUGIN_CODE},
            },
        )
    if prompt == RESTART_FIRST_PROMPT:
        return text_chunks(RESTART_FIRST_TEXT)
    if prompt == RESTART_SECOND_PROMPT:
        if any(
            isinstance(message, dict)
            and RESTART_FIRST_TEXT in message_text(message.get("content"))
            for message in messages
        ):
            raise AssertionError("second isolated process inherited the first process history")
        return text_chunks(RESTART_SECOND_TEXT)
    if prompt == CODE_PROMPT:
        assert_advertised_tool(body, "run_code")
        return tool_call_chunks(
            "call-code-worker",
            "run_code",
            {"code": "return 6 * 7", "description": "Compute the smoke value"},
        )
    if prompt == WORKFLOW_PROMPT:
        assert_advertised_tool(body, "workflow")
        return tool_call_chunks(
            "call-workflow-worker",
            "workflow",
            {
                "script": "return 6 * 7",
                "meta": {
                    "name": "pkg-worker-smoke",
                    "description": "exercise the packaged workflow worker",
                },
            },
        )
    if prompt == FS_SEARCH_PROMPT:
        assert_advertised_tool(body, "grep")
        assert_advertised_tool(body, "glob")
        return tool_call_chunks(
            "fs-search-grep",
            "grep",
            {"pattern": FS_SEARCH_MARKER, "path": "."},
        )
    if prompt == MCP_PROMPT:
        assert_advertised_tool(body, "mcp__fixture__add")
        return tool_call_chunks(
            "mcp-add",
            "mcp__fixture__add",
            {"a": 19, "b": 23},
        )
    if prompt == PROFILE_PLUGIN_PROMPT:
        system_text = "\n".join(
            message_text(message.get("content"))
            for message in messages
            if isinstance(message, dict) and message.get("role") == "system"
        )
        if PROFILE_PLUGIN_MARKER not in system_text:
            raise AssertionError("external profile plugin contributed no model-visible marker")
        return text_chunks(PROFILE_PLUGIN_TEXT)
    return text_chunks(EXPECTED_TEXT)


def mcp_tool_followup(
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Verify one tool call through the packaged MCP client."""
    if call_id != "mcp-add":
        return None
    if tool_name != "mcp__fixture__add" or "42" not in tool_text:
        raise AssertionError(f"packaged MCP call returned an unexpected result: {tool_name}: {tool_text}")
    return text_chunks(MCP_TEXT)


def fs_search_tool_followup(
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Exercise both ripgrep-backed tools through the packaged executable."""
    if not call_id.startswith("fs-search-"):
        return None
    if call_id == "fs-search-grep" and tool_name == "grep":
        if "needle.txt" not in tool_text or FS_SEARCH_MARKER not in tool_text:
            raise AssertionError(f"packaged grep returned no marker: {tool_text}")
        return tool_call_chunks(
            "fs-search-glob",
            "glob",
            {"pattern": "**/*.txt"},
        )
    if call_id == "fs-search-glob" and tool_name == "glob":
        if "needle.txt" not in tool_text:
            raise AssertionError(f"packaged glob returned no fixture path: {tool_text}")
        return text_chunks(FS_SEARCH_TEXT)
    raise AssertionError(f"unexpected filesystem-search follow-up: {call_id} {tool_name}: {tool_text}")


def minimal_tool_followup(
    body: dict[str, object],
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Verify the checked-in minimal composition's PTY and editor."""
    if not call_id.startswith("minimal-"):
        return None
    if call_id == "minimal-bash-1" and tool_name == MINIMAL_SHELL_TOOL:
        if "COUNT=1" not in tool_text:
            raise AssertionError(f"first persistent shell call lost its output: {tool_text}")
        return tool_call_chunks(
            "minimal-bash-2",
            MINIMAL_SHELL_TOOL,
            {"command": MINIMAL_SHELL_COMMAND},
        )
    if call_id == "minimal-bash-2" and tool_name == MINIMAL_SHELL_TOOL:
        expected = f"COUNT=2 CWD={MINIMAL_SHELL_SECOND_CWD}"
        if expected.lower() not in tool_text.lower():
            raise AssertionError(f"persistent shell did not retain state: {tool_text}")
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise AssertionError("persistent editor smoke request has no messages")
        editor_path = next(
            (
                text.split(MINIMAL_EDITOR_PATH_PREFIX, 1)[1].strip()
                for message in messages
                if isinstance(message, dict) and message.get("role") == "user"
                for text in [message_text(message.get("content"))]
                if MINIMAL_EDITOR_PATH_PREFIX in text
            ),
            None,
        )
        if editor_path is None:
            raise AssertionError("persistent editor smoke prompt has no editor path")
        return tool_call_chunks(
            "minimal-editor",
            "str_replace_editor",
            {
                "command": "create",
                "path": editor_path,
                "file_text": "created by packaged editor\n",
            },
        )
    if call_id == "minimal-editor" and tool_name == "str_replace_editor":
        if "New file created successfully" not in tool_text:
            raise AssertionError(f"packaged editor did not create its file: {tool_text}")
        return text_chunks(MINIMAL_TEXT)
    raise AssertionError(f"unexpected minimal-agent follow-up: {call_id} {tool_name}: {tool_text}")


def advanced_tool_followup(
    body: dict[str, object],
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Advance the executable snapshot's deterministic parent tool chain."""
    if not call_id.startswith("advanced-"):
        return None
    if call_id == "advanced-define" and tool_name == "cordis_define":
        if "Defined snap-1/pkg-1 (Snapshot Double)" not in tool_text:
            raise AssertionError(f"cordis_define returned no dynamic Package ids: {tool_text}")
        if "snapshot_double" in advertised_tool_names(body):
            raise AssertionError("snapshot_double was advertised before cordis_run")
        assert_advertised_tool(body, "cordis_run")
        return tool_call_chunks(
            "advanced-run",
            "cordis_run",
            {"pluginId": "snap-1", "packageId": "pkg-1", "mode": "run"},
        )
    if call_id == "advanced-run" and tool_name == "cordis_run":
        if "snap-1/pkg-1 is running (run-1)" not in tool_text:
            raise AssertionError(f"cordis_run returned no running Package ids: {tool_text}")
        assert_advertised_tool(body, "run_code")
        assert_advertised_tool(body, "snapshot_double")
        return tool_call_chunks(
            "advanced-code",
            "run_code",
            {
                "code": "return await tools.snapshot_double({ value: 21 })",
                "description": "Run the temporary Plugin tool",
            },
        )
    if call_id == "advanced-code" and tool_name == "run_code":
        if "42" not in tool_text:
            raise AssertionError(f"run_code returned no dynamic-tool value: {tool_text}")
        assert_advertised_tool(body, "subagent")
        return tool_call_chunks(
            "advanced-direct-child",
            "subagent",
            {
                "description": "Check direct child",
                "prompt": SNAPSHOT_DIRECT_CHILD_PROMPT,
            },
        )
    if call_id == "advanced-direct-child" and tool_name == "subagent":
        if "DIRECT_CHILD_OK" not in tool_text:
            raise AssertionError(f"subagent returned no expected child value: {tool_text}")
        assert_advertised_tool(body, "workflow")
        return tool_call_chunks(
            "advanced-workflow",
            "workflow",
            {
                "script": SNAPSHOT_WORKFLOW_SCRIPT,
                "meta": {
                    "name": "advanced-exe-snapshot",
                    "description": "exercise one packaged workflow child",
                },
            },
        )
    if call_id == "advanced-workflow" and tool_name == "workflow":
        if "WORKFLOW_CHILD_OK" not in tool_text:
            raise AssertionError(f"workflow returned no expected child value: {tool_text}")
        assert_advertised_tool(body, "cordis_undefine")
        return tool_call_chunks(
            "advanced-undefine",
            "cordis_undefine",
            {"pluginId": "snap-1"},
        )
    if call_id == "advanced-undefine" and tool_name == "cordis_undefine":
        if "Removed dynamic Plugin snap-1 and all of its Packages." not in tool_text:
            raise AssertionError(f"cordis_undefine returned no removal result: {tool_text}")
        if "snapshot_double" in advertised_tool_names(body):
            raise AssertionError("snapshot_double remained advertised after cordis_undefine")
        return text_chunks(SNAPSHOT_FINAL_TEXT)
    raise AssertionError(f"unexpected advanced tool follow-up: {call_id} {tool_name}: {tool_text}")


def text_chunks(text: str) -> list[dict[str, object]]:
    """Build a complete streaming text response."""
    return [
        {"choices": [{"delta": {"role": "assistant", "content": None, "reasoning_content": ""}}]},
        {"choices": [{"delta": {"content": text}}]},
        {
            "choices": [{"delta": {"content": ""}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3},
        },
    ]


def tool_call_chunks(call_id: str, name: str, arguments: dict[str, object]) -> list[dict[str, object]]:
    """Build a complete streaming function-call response."""
    return [
        {"choices": [{"delta": {"role": "assistant", "content": None, "reasoning_content": ""}}]},
        {
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    }],
                },
            }],
        },
        {
            "choices": [{"delta": {"content": ""}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3},
        },
    ]


def latest_tool_call(messages: list[object]) -> tuple[str, str]:
    """Find the assistant call id and name paired with the latest tool result."""
    for message in reversed(messages[:-1]):
        if not isinstance(message, dict):
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in reversed(calls):
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            call_id = call.get("id")
            if (
                isinstance(call_id, str)
                and isinstance(function, dict)
                and isinstance(function.get("name"), str)
            ):
                return call_id, function["name"]
    raise AssertionError(f"tool result has no preceding assistant tool call: {messages}")


def message_text(content: object) -> str:
    """Read OpenAI text content in either string or block-list form."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def advertised_tool_names(body: dict[str, object]) -> set[str]:
    """Return the model-facing tool names advertised on one request."""
    tools = body.get("tools")
    if not isinstance(tools, list):
        raise AssertionError(f"model request advertised no tools: {body}")
    names: set[str] = set()
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.add(function["name"])
    return names


def assert_advertised_tool(body: dict[str, object], expected: str) -> None:
    """Require the packaged deployment to expose the requested tool."""
    names = advertised_tool_names(body)
    if expected not in names:
        raise AssertionError(f"model request did not advertise {expected}: {names}")


class MockModel:
    def __enter__(self) -> "MockModel":
        MockModelHandler.requests.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MockModelHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.url = f"http://{host}:{port}"
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        choices=("all", "sdk-default", "sdk-custom", "sdk-minimal", "sdk-fs-search", "sdk-mcp", "sdk-snapshot", "sdk-restart", "sdk-profile-plugin", "sdk-live", "direct"),
        default="all",
    )
    parser.add_argument("--exe", type=Path)
    parser.add_argument(
        "--installed-wheel",
        action="store_true",
        help="require a clean virtual environment containing matching installed SDK and runtime wheels",
    )
    parser.add_argument("--update-snapshots", action="store_true")
    args = parser.parse_args()
    if args.installed_wheel and args.exe is not None:
        parser.error("--installed-wheel resolves the wheel's own runtime and cannot be combined with --exe")
    if args.scenario == "sdk-live" and not args.installed_wheel:
        parser.error("--scenario sdk-live requires --installed-wheel")
    if args.scenario == "sdk-profile-plugin" and not args.installed_wheel:
        parser.error("--scenario sdk-profile-plugin requires --installed-wheel")
    if args.installed_wheel:
        args.exe = assert_installed_wheel_environment()
    if args.scenario in {"all", "sdk-custom", "sdk-minimal", "sdk-fs-search", "sdk-snapshot", "sdk-restart", "direct"} and args.exe is None:
        parser.error("--exe is required for custom, minimal, snapshot, and direct scenarios")
    if args.update_snapshots and args.scenario not in {"all", "sdk-minimal", "sdk-snapshot", "sdk-restart"}:
        parser.error("--update-snapshots requires --scenario sdk-minimal, sdk-snapshot, sdk-restart, or all")
    if args.exe is not None and not args.exe.is_file():
        parser.error(f"runtime executable does not exist: {args.exe}")

    if args.scenario == "sdk-live":
        smoke_sdk_live()
        print("smoke-python-runtime: sdk-live passed")
        return

    with MockModel() as model:
        if args.scenario in {"all", "sdk-default"}:
            smoke_sdk_default(model.url)
        if args.scenario in {"all", "sdk-custom"}:
            assert args.exe is not None
            smoke_sdk_custom(model.url, args.exe.resolve())
        if args.scenario in {"all", "sdk-minimal"}:
            assert args.exe is not None
            smoke_sdk_minimal(model.url, args.exe.resolve(), args.update_snapshots)
        if args.scenario in {"all", "sdk-fs-search"}:
            assert args.exe is not None
            smoke_sdk_fs_search(model.url, args.exe.resolve())
        if args.scenario in {"all", "sdk-mcp"}:
            smoke_sdk_mcp(model.url, None if args.exe is None else args.exe.resolve())
        if args.scenario in {"all", "sdk-snapshot"}:
            assert args.exe is not None
            smoke_sdk_snapshot(model.url, args.exe.resolve(), args.update_snapshots)
        if args.scenario in {"all", "sdk-restart"}:
            assert args.exe is not None
            smoke_sdk_restart_snapshot(model.url, args.exe.resolve(), args.update_snapshots)
        if args.installed_wheel and args.scenario in {"all", "sdk-profile-plugin"}:
            smoke_sdk_profile_plugin(model.url)
        if args.scenario in {"all", "direct"}:
            assert args.exe is not None
            smoke_direct(model.url, args.exe.resolve())
        if not MockModelHandler.requests:
            raise AssertionError("mock model endpoint received no requests")
    print(f"smoke-python-runtime: {args.scenario} passed")


def assert_installed_wheel_environment() -> Path:
    """Prove that this process imports matching non-editable wheel installations."""
    if sys.prefix == sys.base_prefix:
        raise AssertionError("installed-wheel smoke must run inside a virtual environment")
    if os.environ.get("PYTHONPATH"):
        raise AssertionError("installed-wheel smoke requires PYTHONPATH to be unset")
    if os.environ.get("DSH_RUNTIME_MODE"):
        raise AssertionError("installed-wheel smoke requires DSH_RUNTIME_MODE to be unset")

    repo_root = Path(__file__).resolve().parent.parent
    cwd = Path.cwd().resolve()
    if cwd.is_relative_to(repo_root):
        raise AssertionError(f"installed-wheel smoke must run outside the repository, got {cwd}")

    sdk_version = importlib.metadata.version("deepseek-harness-sdk")
    runtime_version = importlib.metadata.version("deepseek-harness-runtime-bin")
    if sdk_version != runtime_version:
        raise AssertionError(
            f"installed SDK/runtime versions differ: {sdk_version} != {runtime_version}"
        )
    expected_runtime_requirement = f"deepseek-harness-runtime-bin=={sdk_version}"
    requirements = importlib.metadata.requires("deepseek-harness-sdk") or []
    if expected_runtime_requirement not in requirements:
        raise AssertionError(
            f"installed SDK does not require {expected_runtime_requirement}: {requirements}"
        )

    prefix = Path(sys.prefix).resolve()
    imported: dict[str, Path] = {}
    for name in ("deepseek_harness", "deepseek_harness_runtime"):
        module = importlib.import_module(name)
        module_file = getattr(module, "__file__", None)
        if not isinstance(module_file, str):
            raise AssertionError(f"installed module {name} has no filesystem location")
        path = Path(module_file).resolve()
        if not path.is_relative_to(prefix):
            raise AssertionError(f"installed module {name} came from outside the virtual environment: {path}")
        if path.is_relative_to(repo_root):
            raise AssertionError(f"installed module {name} came from the repository checkout: {path}")
        imported[name] = path

    runtime_module = sys.modules["deepseek_harness_runtime"]
    executable = runtime_module.bundled_runtime_path().resolve()
    runtime_package = imported["deepseek_harness_runtime"].parent
    if not executable.is_relative_to(runtime_package):
        raise AssertionError(f"bundled runtime came from outside the installed runtime wheel: {executable}")
    runtime_files = importlib.metadata.files("deepseek-harness-runtime-bin") or []
    if not any(Path(file).name == executable.name for file in runtime_files):
        raise AssertionError(f"runtime executable is absent from installed distribution records: {executable}")
    return executable


def smoke_sdk_live() -> None:
    """Run a real-model, tool-using two-turn task through installed wheels."""
    from deepseek_harness import DeepSeekHarness

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    base_url = os.environ.get("DEEPSEEK_BASE_URL")
    if not api_key:
        raise AssertionError("sdk-live requires DEEPSEEK_API_KEY")
    if not base_url:
        raise AssertionError("sdk-live requires an explicit DEEPSEEK_BASE_URL")

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-live-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        marker = root / "live-api-marker.txt"
        session_id = "installed-wheel-live-api"
        shell_tool = "pwsh" if IS_WINDOWS else "bash"
        create_prompt = (
            f"Use the {shell_tool} tool to create the file at the absolute path below with exactly one line "
            f"containing {LIVE_API_SENTINEL}. Then reply with exactly {LIVE_API_SENTINEL}.\n{marker}"
        )
        verify_prompt = (
            "Use a tool to read the file created in the previous turn. "
            f"If its only line is {LIVE_API_SENTINEL}, reply with exactly {LIVE_API_SENTINEL}."
        )
        with DeepSeekHarness(
            provider="deepseek-official",
            model="deepseek-v4-flash",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key=api_key,
            base_url=base_url,
            request_timeout_seconds=180,
        ) as harness:
            created = harness.run(create_prompt, session_id=session_id)
            verified = harness.run(verify_prompt, session_id=session_id)

        for label, result in (("create", created), ("verify", verified)):
            if result.finish_reason != "completed":
                event_types = [event.get("type") for event in result.events]
                turn_end_data = next(
                    (event.get("data") for event in reversed(result.events) if event.get("type") == "turn/end"),
                    None,
                )
                turn_end = safe_turn_end(turn_end_data)
                raise AssertionError(
                    f"{label} turn ended with {result.finish_reason!r}; "
                    f"final={result.final_response!r}; turn_end={turn_end!r}; events={event_types}"
                )
            if not any(event.get("type") == "tool/call" for event in result.events):
                raise AssertionError(
                    f"{label} turn made no model-requested tool call; "
                    f"final={result.final_response!r}"
                )
            if result.final_response.strip() != LIVE_API_SENTINEL:
                raise AssertionError(f"{label} turn returned {result.final_response!r}")
        if not marker.is_file():
            raise AssertionError(f"real-model tool turn did not create {marker}")
        if marker.read_text(encoding="utf-8").splitlines() != [LIVE_API_SENTINEL]:
            raise AssertionError(f"real-model tool turn wrote unexpected text to {marker}")
        assert_zstd_session_log(sessions)


def safe_turn_end(value: object) -> object:
    """Project a live-provider failure without retaining credential-bearing text."""
    if not isinstance(value, dict):
        return value
    reason = value.get("reason")
    if not isinstance(reason, dict):
        return {"turn": value.get("turn"), "reason": reason}
    error = reason.get("error")
    safe_error = None
    if isinstance(error, dict):
        safe_error = {
            key: error.get(key)
            for key in ("code", "status")
            if error.get(key) is not None
        }
    return {
        "turn": value.get("turn"),
        "reason": {
            "kind": reason.get("kind"),
            **({"error": safe_error} if safe_error is not None else {}),
        },
    }


def smoke_sdk_default(base_url: str) -> None:
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-default-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run("reply with the smoke text", session_id="default-smoke")
        assert result.final_response == EXPECTED_TEXT, (
            f"final={result.final_response!r} finish={result.finish_reason!r} "
            f"events={[event.get('type') for event in result.events]!r} "
            f"turn_end={safe_turn_end(next((event.get('data', event) for event in reversed(result.events) if event.get('type') == 'turn/end'), {}))!r}"
        )
        assert_zstd_session_log(sessions)


def smoke_sdk_custom(base_url: str, executable: Path) -> None:
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-custom-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "custom.patch.yml", sessions)
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch),),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            text_result = harness.run("reply with the smoke text", session_id="custom-smoke")
            code_result = harness.run(CODE_PROMPT, session_id="custom-smoke")
            workflow_result = harness.run(WORKFLOW_PROMPT, session_id="custom-smoke")
        assert text_result.final_response == EXPECTED_TEXT, text_result.final_response
        assert code_result.final_response == CODE_WORKER_TEXT, code_result.final_response
        assert workflow_result.final_response == WORKFLOW_WORKER_TEXT, workflow_result.final_response
        assert_session_log(sessions, root, EXPECTED_TEXT, CODE_WORKER_TEXT, WORKFLOW_WORKER_TEXT)


def smoke_sdk_minimal(base_url: str, executable: Path, update_snapshots: bool) -> None:
    """Exercise the shipped standalone minimal profile through the packaged executable."""
    from deepseek_harness import DeepSeekHarness

    # One mock model serves every scenario of a run, so the snapshot takes this turn's slice.
    first_request = len(MockModelHandler.requests)
    with tempfile.TemporaryDirectory(prefix="dsh-sdk-minimal-") as temporary:
        root = Path(temporary).resolve()
        editor_path = root / "created.txt"
        prompt = f"{MINIMAL_PROMPT}\n{MINIMAL_EDITOR_PATH_PREFIX}{editor_path}"
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            profile="sdk-minimal",
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(prompt, session_id="minimal-agent-smoke")

        event_text = json.dumps(result.events)
        if MINIMAL_TEXT not in event_text:
            raise AssertionError(f"minimal agent run emitted no final response: {result.events}")
        if editor_path.read_text() != "created by packaged editor\n":
            raise AssertionError(f"packaged editor wrote unexpected content: {editor_path.read_text()!r}")
        assert_session_log(sessions, root, MINIMAL_TEXT, "COUNT=1", "COUNT=2")

        files = build_minimal_snapshot_files(MockModelHandler.requests[first_request:], root)
        compare_snapshot_files(
            files, update_snapshots, MINIMAL_SNAPSHOT_DIRECTORY, MINIMAL_SNAPSHOT_FILENAMES,
        )


def smoke_sdk_fs_search(base_url: str, executable: Path) -> None:
    """Exercise real grep and glob spawns through the packaged executable."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-fs-search-") as temporary:
        root = Path(temporary).resolve()
        (root / "needle.txt").write_text(f"{FS_SEARCH_MARKER}\n")
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_profile_patch(root, "fs-search.patch.yml", sessions, [
            {"id": "skill-filesystem", "disabled": True},
            {"id": "tool-fs-search", "config": {"sampleOverCapGlobResults": False}},
        ])
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch),),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(FS_SEARCH_PROMPT, session_id="fs-search-smoke")

        assert result.final_response == FS_SEARCH_TEXT, result.final_response
        assert_session_log(sessions, root, FS_SEARCH_TEXT, FS_SEARCH_MARKER, "needle.txt")


def smoke_sdk_mcp(base_url: str, executable: Path | None) -> None:
    """Discover and call an external stdio MCP tool through the packaged client."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-mcp-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        server_script = root / "mcp_server.py"
        server_script.write_text(MCP_SERVER_SCRIPT)
        patch = write_mcp_patch(root, sessions, server_script)
        discovery_log = server_script.with_suffix(".log")
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=None if executable is None else str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch),),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(MCP_PROMPT, session_id="mcp-smoke")

        assert result.final_response == MCP_TEXT, result.final_response
        assert discovery_log.read_text().splitlines() == [
            "initialize",
            "notifications/initialized",
            "tools/list",
            "tools/call",
        ]
        assert_session_log(sessions, root, MCP_TEXT, "mcp__fixture__add", "42")


def smoke_sdk_profile_plugin(base_url: str) -> None:
    """Install an external bundle through Python's dsh command and load it in the SDK."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-profile-plugin-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        plugin = root / "plugin"
        plugin.mkdir()
        (plugin / "package.json").write_text(json.dumps({
            "name": "dsh-python-blackbox-plugin",
            "version": "1.0.0",
            "private": True,
            "type": "module",
            "exports": "./index.js",
            "peerDependencies": {"@deepseek-ai/cordis": "*"},
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
        }, indent=2))
        (plugin / "index.js").write_text(
            "import { Context } from '@deepseek-ai/cordis'\n"
            "export const name = 'python-sdk-blackbox-plugin'\n"
            "export const inject = ['systemPrompt']\n"
            "export function apply(ctx) {\n"
            "  if (!(ctx instanceof Context)) throw new Error('external plugin loaded a second Cordis instance')\n"
            "  ctx.effect(() => ctx.systemPrompt.section({\n"
            "    name: 'python-sdk:blackbox-plugin',\n"
            "    order: 10,\n"
            f"    text: '{PROFILE_PLUGIN_MARKER}',\n"
            "  }))\n"
            "}\n"
        )
        (plugin / "cordis.patch.yml").write_text(json.dumps([{
            "insert": [{"id": "python-sdk-blackbox-plugin", "name": "dsh-python-blackbox-plugin"}],
        }], indent=2))

        dsh = Path(sysconfig.get_path("scripts")) / ("dsh.exe" if IS_WINDOWS else "dsh")
        environment = {**os.environ, "DSH_HOME": str(dsh_home)}
        installed = subprocess.run(
            [str(dsh), "plugin", "--profile", "sdk", "add", f"file:{plugin}"],
            cwd=root,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        if installed.returncode != 0:
            raise AssertionError(
                f"Python-installed dsh could not add the external profile plugin: "
                f"stdout={installed.stdout!r} stderr={installed.stderr!r}"
            )
        manifest = json.loads((dsh_home / "profiles" / "sdk" / "package.json").read_text())
        if "dsh-python-blackbox-plugin" not in manifest.get("dependencies", {}):
            raise AssertionError(f"dsh plugin did not record the external dependency: {manifest}")
        if "dsh-python-blackbox-plugin" not in manifest["dsh"]["profile"]["bundles"]:
            raise AssertionError(f"dsh plugin did not activate the external bundle: {manifest}")

        harness = DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        )
        try:
            with harness:
                result = harness.run(PROFILE_PLUGIN_PROMPT, session_id="profile-plugin-smoke")
        except Exception as error:
            raise AssertionError(
                f"external profile plugin runtime failed: {harness.client._runtime_diagnostics()}"
            ) from error

        assert result.final_response == PROFILE_PLUGIN_TEXT, result.final_response
        assert_zstd_session_log(dsh_home / "sessions")


def smoke_sdk_snapshot(base_url: str, executable: Path, update_snapshots: bool) -> None:
    """Drive and compare the advanced SDK/executable behavioral snapshot."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-snapshot-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "snapshot.patch.yml", sessions)
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch),),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(SNAPSHOT_PROMPT, session_id=SNAPSHOT_SESSION_ID)

        assert result.final_response == SNAPSHOT_FINAL_TEXT, result.final_response
        methods = [notification.method for notification in result.notifications]
        if methods.count("subagent.started") != 2 or methods.count("subagent.finished") != 2:
            raise AssertionError(f"advanced snapshot emitted unexpected subagent lifecycle: {methods}")
        if not any(event.get("type") == "tool/code-dispatch" for event in result.events):
            raise AssertionError("advanced snapshot emitted no tool/code-dispatch event")

        logs = read_session_logs(sessions)
        child_ids = snapshot_child_ids(result)
        expected_ids = {SNAPSHOT_SESSION_ID, *child_ids}
        if set(logs) != expected_ids:
            raise AssertionError(f"advanced snapshot expected parent plus two child logs: {sorted(logs)}")
        if "DIRECT_CHILD_OK" not in render_jsonl(logs[child_ids[0]]):
            raise AssertionError("first advanced child log has no direct-subagent result")
        if "WORKFLOW_CHILD_OK" not in render_jsonl(logs[child_ids[1]]):
            raise AssertionError("second advanced child log has no workflow-subagent result")

        files = build_snapshot_files(result, logs, child_ids, root)
        compare_snapshot_files(
            files, update_snapshots, ADVANCED_SNAPSHOT_DIRECTORY, ADVANCED_SNAPSHOT_FILENAMES,
        )


def smoke_sdk_restart_snapshot(base_url: str, executable: Path, update_snapshots: bool) -> None:
    """Snapshot two isolated sessions across complete SDK runtime restarts."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-restart-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "restart.patch.yml", sessions)
        first_request = len(MockModelHandler.requests)

        def run(prompt: str, session_id: str) -> "RunResult":
            with DeepSeekHarness(
                provider="deepseek-official",
                model="smoke-model",
                cwd=str(root),
                dsh_bin=str(executable),
                dsh_home=str(dsh_home),
                patches=(str(patch),),
                env={
                    "DSH_PERMISSION_MODE": "danger-full-access",
                    "DSH_TELEMETRY_DISABLED": "1",
                },
                api_key="sk-keyless-smoke",
                base_url=base_url,
                request_timeout_seconds=60,
            ) as harness:
                return harness.run(prompt, session_id=session_id)

        first = run(RESTART_FIRST_PROMPT, RESTART_FIRST_SESSION_ID)
        second = run(RESTART_SECOND_PROMPT, RESTART_SECOND_SESSION_ID)
        requests = MockModelHandler.requests[first_request:]
        if len(requests) != 2:
            raise AssertionError(f"restart snapshot expected two model requests: {requests}")
        if first.final_response != RESTART_FIRST_TEXT or second.final_response != RESTART_SECOND_TEXT:
            raise AssertionError(
                f"restart snapshot responses differ: {first.final_response!r}, {second.final_response!r}"
            )

        logs = read_session_logs(sessions)
        expected_ids = {RESTART_FIRST_SESSION_ID, RESTART_SECOND_SESSION_ID}
        if set(logs) != expected_ids:
            raise AssertionError(f"restart snapshot expected two durable sessions: {sorted(logs)}")
        for session_id, expected in (
            (RESTART_FIRST_SESSION_ID, RESTART_FIRST_TEXT),
            (RESTART_SECOND_SESSION_ID, RESTART_SECOND_TEXT),
        ):
            records = logs[session_id]
            if sum(record.get("type") == "turn/end" for record in records) != 1:
                raise AssertionError(f"restart snapshot {session_id} has an unexpected turn count")
            if expected not in render_jsonl(records):
                raise AssertionError(f"restart snapshot durable log has no {expected}")

        files = build_restart_snapshot_files(first, second, requests, logs, root, sessions)
        compare_snapshot_files(
            files, update_snapshots, RESTART_SNAPSHOT_DIRECTORY, RESTART_SNAPSHOT_FILENAMES,
        )


def smoke_direct(base_url: str, executable: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="dsh-direct-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_profile_patch(root, "direct.patch.yml", sessions, [])
        environment = {
            **os.environ,
            "DSH_HOME": str(dsh_home),
            "DSH_PERMISSION_MODE": "danger-full-access",
            "DSH_TELEMETRY_DISABLED": "1",
            "DEEPSEEK_API_KEY": "sk-keyless-smoke",
            "DEEPSEEK_BASE_URL": base_url,
        }
        peer = RuntimePeer(
            [str(executable), "--profile", "sdk", "--patch", str(patch)],
            root,
            environment,
        )
        try:
            peer.send({"jsonrpc": "2.0", "id": "initialize", "method": "initialize", "params": {"cwd": str(root), "provider": "deepseek-official", "model": "smoke-model"}})
            peer.read_until(lambda message: message.get("id") == "initialize")
            peer.send({
                "jsonrpc": "2.0",
                "id": "prompt",
                "method": "session/prompt",
                "params": {"sessionId": "direct-smoke", "contentBlocks": [{"type": "text", "text": "reply with the smoke text"}]},
            })
            messages = peer.read_until(lambda message: message.get("id") == "prompt")
            if not any(is_idle_notification(message) for message in messages):
                messages.extend(peer.read_until(is_idle_notification))
            event_text = json.dumps(messages)
            if EXPECTED_TEXT not in event_text:
                raise AssertionError(f"direct runtime emitted no final response: {messages}")
            peer.send({"jsonrpc": "2.0", "id": "shutdown", "method": "shutdown"})
            peer.read_until(lambda message: message.get("id") == "shutdown")
        finally:
            peer.close()
        assert_session_log(sessions, root, EXPECTED_TEXT)


def is_idle_notification(message: dict[str, object]) -> bool:
    """Return whether a JSON-RPC notification marks a session idle."""
    params = message.get("params")
    return (
        message.get("method") == "session.status"
        and isinstance(params, dict)
        and params.get("status") == "idle"
    )


class RuntimePeer:
    def __init__(self, argv: list[str], cwd: Path, environment: dict[str, str]) -> None:
        self.process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.stdout: queue.Queue[str | None] = queue.Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def send(self, message: dict[str, object]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("runtime stdin is unavailable")
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def read_until(self, predicate: Callable[[dict[str, object]], bool]) -> list[dict[str, object]]:
        deadline = time.monotonic() + 60
        messages: list[dict[str, object]] = []
        while time.monotonic() < deadline:
            try:
                line = self.stdout.get(timeout=min(0.25, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if line is None:
                raise RuntimeError(f"runtime exited before expected message; stderr: {''.join(self.stderr)}")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            messages.append(message)
            if predicate(message):
                return messages
        raise TimeoutError(f"runtime timed out; messages={messages}; stderr={''.join(self.stderr)}")

    def close(self) -> None:
        if self.process.stdin is not None and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        if self.process.returncode not in {0, -15}:
            raise RuntimeError(f"runtime exited {self.process.returncode}; stderr: {''.join(self.stderr)}")

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.stdout.put(line)
        self.stdout.put(None)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        self.stderr.extend(self.process.stderr)


def assert_session_log(sessions: Path, cwd: Path, *expected_texts: str) -> None:
    logs = list(sessions.rglob("*.jsonl"))
    if len(logs) != 1:
        raise AssertionError(f"expected one JSONL session log under {sessions}, found {logs}")
    lines = logs[0].read_text().splitlines()
    header = json.loads(lines[0])
    if header.get("cwd") != str(cwd):
        raise AssertionError(f"session header cwd is not absolute/canonical: {header}")
    rendered = "\n".join(lines)
    for expected in expected_texts:
        if expected not in rendered:
            raise AssertionError(f"session log has no {expected!r} response: {logs[0]}")


def assert_zstd_session_log(sessions: Path) -> None:
    logs = list(sessions.rglob("*.jsonl.zstd"))
    if len(logs) != 1:
        raise AssertionError(f"expected one Zstandard JSONL session log under {sessions}, found {logs}")
    if not logs[0].read_bytes().startswith(bytes.fromhex("28b52ffd")):
        raise AssertionError(f"session log has no Zstandard magic: {logs[0]}")


def read_session_logs(sessions: Path) -> dict[str, list[dict[str, object]]]:
    """Parse every persisted JSONL session into a map keyed by header id."""
    logs: dict[str, list[dict[str, object]]] = {}
    for path in sorted(sessions.rglob("*.jsonl")):
        records = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line
        ]
        if not records or records[0].get("type") != "session":
            raise AssertionError(f"session log has no header: {path}")
        session_id = records[0].get("id")
        if not isinstance(session_id, str):
            raise AssertionError(f"session log header has no string id: {path}")
        if session_id in logs:
            raise AssertionError(f"duplicate persisted session id: {session_id}")
        logs[session_id] = records
    return logs


def snapshot_child_ids(result: "RunResult") -> list[str]:
    """Return the two child session ids in their SDK notification order."""
    child_ids: list[str] = []
    for notification in result.notifications:
        if notification.method != "subagent.started":
            continue
        payload = notification.payload
        if payload.get("parentSessionId") != SNAPSHOT_SESSION_ID:
            continue
        child_id = payload.get("childSessionId")
        if isinstance(child_id, str) and child_id not in child_ids:
            child_ids.append(child_id)
    if len(child_ids) != 2:
        raise AssertionError(f"advanced snapshot expected two child session ids: {child_ids}")
    return child_ids


def build_minimal_snapshot_files(
    requests: list[dict[str, object]],
    cwd: Path,
) -> dict[str, str]:
    """Render the minimal composition's model-visible surface as expected output.

    Every assembled system prompt, advertised tool schema, and system or user message is
    kept verbatim: they carry what the deployment actually shows the model, so a plugin
    that contributes an unintended system section or user message cannot pass unnoticed.
    Assistant and tool payloads keep only their call identity because their text differs
    across the platforms this expected output must replay on. The shipped profile omits
    dynamic runtime context, so every message it emits is compared.
    """
    snapshot = []
    for body in requests:
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise AssertionError(f"minimal model request has no messages: {body}")
        snapshot.append({
            "tools": minimal_snapshot_text(body.get("tools"), cwd),
            "messages": [
                minimal_snapshot_message(message, cwd)
                for message in messages
            ],
        })
    return {"model-visible.json": json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n"}


def minimal_snapshot_message(message: object, cwd: Path) -> dict[str, object]:
    """Reduce one model-visible message to its stable, behavior-carrying parts."""
    if not isinstance(message, dict):
        raise AssertionError(f"minimal model request has an invalid message: {message}")
    role = message.get("role")
    if role in ("system", "user"):
        return {"role": role, "text": minimal_snapshot_text(message_text(message.get("content")), cwd)}
    if role == "assistant":
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            raise AssertionError(f"minimal assistant message has no tool calls: {message}")
        return {
            "role": role,
            "toolCalls": [
                {"id": call.get("id"), "name": (call.get("function") or {}).get("name")}
                for call in calls
                if isinstance(call, dict)
            ],
        }
    if role == "tool":
        return {"role": role, "toolCallId": message.get("tool_call_id"), "text": "{{tool-result}}"}
    raise AssertionError(f"minimal model request has an unexpected message role: {message}")


def minimal_snapshot_text(value: object, cwd: Path) -> object:
    """Replace the scenario's temporary working directory everywhere it appears."""
    if isinstance(value, str):
        return value.replace(str(cwd), "{{cwd}}")
    if isinstance(value, list):
        return [minimal_snapshot_text(item, cwd) for item in value]
    if isinstance(value, dict):
        return {key: minimal_snapshot_text(item, cwd) for key, item in value.items()}
    return value


def build_snapshot_files(
    result: "RunResult",
    logs: dict[str, list[dict[str, object]]],
    child_ids: list[str],
    cwd: Path,
) -> dict[str, str]:
    """Render the SDK result and three persisted logs into stable expected outputs."""
    replacements = [(str(cwd), "{{cwd}}"), (SNAPSHOT_SESSION_ID, "{{parent}}")]
    replacements.append((snapshot_workflow_run_id(result), "{{workflow-run}}"))
    for index, child_id in enumerate(child_ids, start=1):
        replacements.append((child_id, f"{{{{child-{index}}}}}"))
        agent_id = snapshot_agent_id(result, child_id)
        replacements.append((agent_id, f"{{{{agent-{index}}}}}"))
    replacements.sort(key=lambda pair: len(pair[0]), reverse=True)

    result_value = {
        "session_id": result.session_id,
        "final_response": result.final_response,
        "events": result.events,
        "notifications": [
            {"method": notification.method, "payload": notification.payload}
            for notification in result.notifications
        ],
    }
    normalized_result = normalize_snapshot_value(result_value, replacements)
    files = {
        "result.json": json.dumps(normalized_result, indent=2, ensure_ascii=False) + "\n",
        "session.jsonl": render_jsonl(
            project_session_snapshot([
                normalize_snapshot_value(record, replacements) for record in logs[SNAPSHOT_SESSION_ID]
            ])
        ),
    }
    for index, child_id in enumerate(child_ids, start=1):
        files[f"session.{index}.jsonl"] = render_jsonl(
            project_session_snapshot([
                normalize_snapshot_value(record, replacements) for record in logs[child_id]
            ])
        )
    return files


def build_restart_snapshot_files(
    first: "RunResult",
    second: "RunResult",
    requests: list[dict[str, object]],
    logs: dict[str, list[dict[str, object]]],
    cwd: Path,
    sessions: Path,
) -> dict[str, str]:
    """Render two SDK processes, isolated model histories, and durable logs."""
    replacements = [
        (str(sessions), "{{sessions}}"),
        (str(cwd), "{{cwd}}"),
        (RESTART_FIRST_SESSION_ID, "{{session-1}}"),
        (RESTART_SECOND_SESSION_ID, "{{session-2}}"),
    ]
    result_value = [
        {
            "session_id": result.session_id,
            "final_response": result.final_response,
            "finish_reason": result.finish_reason,
            "eventTypes": [event.get("type") for event in result.events],
            "notificationMethods": [notification.method for notification in result.notifications],
        }
        for result in (first, second)
    ]
    request_value = [
        {
            "model": request.get("model"),
            "messages": restart_request_messages(request),
            "toolNames": sorted(advertised_tool_names(request)),
        }
        for request in requests
    ]
    return {
        "result.json": json.dumps(
            normalize_snapshot_value(result_value, replacements), indent=2, ensure_ascii=False,
        ) + "\n",
        "requests.json": json.dumps(
            normalize_snapshot_value(request_value, replacements), indent=2, ensure_ascii=False,
        ) + "\n",
        "session.1.jsonl": render_jsonl(project_session_snapshot([
            normalize_snapshot_value(record, replacements) for record in logs[RESTART_FIRST_SESSION_ID]
        ])),
        "session.2.jsonl": render_jsonl(project_session_snapshot([
            normalize_snapshot_value(record, replacements) for record in logs[RESTART_SECOND_SESSION_ID]
        ])),
    }


def restart_request_messages(request: dict[str, object]) -> list[object]:
    """Project model history while tokenizing composition-owned system prose."""
    messages = request.get("messages")
    if not isinstance(messages, list):
        raise AssertionError(f"restart snapshot request has no messages: {request}")
    return [
        {"role": "system", "content": "{{system}}"}
        if isinstance(message, dict) and message.get("role") == "system"
        else message
        for message in messages
    ]


def snapshot_workflow_run_id(result: "RunResult") -> str:
    """Return the one workflow run id emitted by the advanced scenario."""
    run_ids: set[str] = set()
    for event in result.events:
        event_type = event.get("type")
        data = event.get("data")
        if not isinstance(event_type, str) or not event_type.startswith("tool-workflow/"):
            continue
        if isinstance(data, dict) and isinstance(data.get("runId"), str):
            run_ids.add(data["runId"])
    if len(run_ids) != 1:
        raise AssertionError(f"advanced snapshot expected one workflow run id: {sorted(run_ids)}")
    return next(iter(run_ids))


def snapshot_agent_id(result: "RunResult", child_id: str) -> str:
    """Find the successful subagent id paired with one child session."""
    for notification in result.notifications:
        if notification.method != "subagent.finished":
            continue
        payload = notification.payload
        if payload.get("childSessionId") != child_id:
            continue
        if payload.get("provider") != "spawn" or payload.get("status") != "ok":
            raise AssertionError(f"advanced child did not finish successfully: {payload}")
        agent_id = payload.get("agentId")
        if isinstance(agent_id, str):
            return agent_id
    raise AssertionError(f"advanced snapshot has no finished agent for child {child_id}")


def normalize_snapshot_value(
    value: object,
    replacements: list[tuple[str, str]],
) -> object:
    """Scrub volatile values and bulky request headers without losing behavior."""
    if isinstance(value, str):
        normalized = value
        for actual, token in replacements:
            normalized = normalized.replace(actual, token)
        return normalized
    if isinstance(value, list):
        return [normalize_snapshot_value(item, replacements) for item in value]
    if not isinstance(value, dict):
        return value

    normalized = {
        key: normalize_snapshot_value(item, replacements)
        for key, item in value.items()
    }
    if normalized.get("type") == "session" and "createdAt" in normalized:
        normalized["createdAt"] = 0
    if "seq" in normalized and "time" in normalized:
        normalized["time"] = 0
    if isinstance(normalized.get("id"), str) and normalized.get("role") in ("assistant", "user"):
        normalized["id"] = "{{messageId}}"
    scrub_snapshot_header(normalized)
    return normalized


def scrub_snapshot_header(value: dict[object, object]) -> None:
    """Tokenize full request-header bulk while retaining tool names."""
    data = value.get("data")
    if not isinstance(data, dict):
        return
    if value.get("type") == "request/header":
        header = data.get("header")
        if not isinstance(header, dict):
            return
        if "system" in header:
            header["system"] = "{{system}}"
        tools = header.get("tools")
        if isinstance(tools, list):
            header["tools"] = [
                tool.get("name") if isinstance(tool, dict) else "{{tools}}"
                for tool in tools
            ]


def render_jsonl(records: list[object]) -> str:
    """Render parsed JSON values as compact, newline-terminated JSONL."""
    return "".join(
        json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        for record in records
    )


def project_session_snapshot(records: list[dict[str, object]]) -> list[dict[str, object]]:
    """Omit storage sequence/time envelopes from snapshot body records."""
    projected = [dict(record) for record in records]
    for record in projected[1:]:
        for key in ("seq", "time", "seq0", "time0"):
            record.pop(key, None)
    return projected


def compare_snapshot_files(
    files: dict[str, str],
    update: bool,
    directory: Path,
    filenames: tuple[str, ...],
) -> None:
    """Write or exactly compare one scenario's expected snapshot files."""
    scenario = directory.name
    if tuple(files) != filenames:
        raise AssertionError(f"{scenario} snapshot builder produced {tuple(files)}, expected {filenames}")
    if update:
        directory.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (directory / name).write_text(content, encoding="utf-8", newline="\n")
        print(f"smoke-python-runtime: updated snapshots in {directory}")

    existing = {
        path.name
        for path in directory.iterdir()
        if path.is_file()
    } if directory.is_dir() else set()
    expected = set(filenames)
    if existing != expected:
        raise AssertionError(
            f"{scenario} snapshot files differ: "
            f"missing={sorted(expected - existing)}, unexpected={sorted(existing - expected)}"
        )
    for name, actual in files.items():
        expected_text = (directory / name).read_text(encoding="utf-8")
        if actual == expected_text:
            continue
        diff = "".join(difflib.unified_diff(
            expected_text.splitlines(keepends=True),
            actual.splitlines(keepends=True),
            fromfile=f"expected/{name}",
            tofile=f"actual/{name}",
        ))
        raise AssertionError(
            f"{scenario} executable snapshot mismatch in {name}; "
            "rerun with --update-snapshots after reviewing the behavior\n"
            f"{diff}"
        )


if __name__ == "__main__":
    main()
