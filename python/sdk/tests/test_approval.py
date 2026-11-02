"""Approval request decoding and explicit wire capability negotiation."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from deepseek_harness import ApprovalRequestParams, ApprovalRequestResult, DeepSeekHarnessConfig, HarnessClient


@pytest.mark.parametrize("enabled", [False, True])
def test_approval_handshake_and_response(tmp_path: Path, enabled: bool) -> None:
    peer = tmp_path / "approval_peer.py"
    peer.write_text('''import json
import sys
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "test"}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "capability", "params": msg["params"]}), flush=True)
        if msg["params"].get("approvalRequests"):
            print(json.dumps({"jsonrpc": "2.0", "id": "ask", "method": "approval/request", "params": {"sessionId": "main", "toolName": "bash", "reason": "write"}}), flush=True)
    elif msg.get("id") == "ask":
        print(json.dumps({"jsonrpc": "2.0", "method": "decision", "params": msg["result"]}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
''')
    with HarnessClient(_launch_args=(sys.executable, str(peer))) as client:
        client.initialize(cwd=str(tmp_path), provider="mock", model="mock", approval_requests=enabled)
        payload = client.next_notification().payload
        assert payload.get("approvalRequests", False) is enabled
        if not enabled:
            assert "approvalRequests" not in payload
            return
        request = client.next_request()
        assert request.method == "approval/request"
        question = ApprovalRequestParams.model_validate(request.payload)
        assert question.toolName == "bash"
        assert question.callId is None
        client.respond(request.id, ApprovalRequestResult(outcome="rejected").model_dump())
        assert client.next_notification().payload == {"outcome": "rejected"}


def test_approval_result_rejects_unrecognized_grants() -> None:
    with pytest.raises(ValidationError):
        ApprovalRequestResult(outcome="allow-always")


def test_approval_opt_in_preserves_existing_config_positional_arguments() -> None:
    config = DeepSeekHarnessConfig("mock", "model", None, None, "/workspace")
    assert config.cwd == "/workspace"
    assert config.approval_requests is False
