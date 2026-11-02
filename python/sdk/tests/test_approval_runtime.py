"""Python decisions control a guarded file operation through the built sdk profile."""
from __future__ import annotations

import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from pydantic import BaseModel

from deepseek_harness import ApprovalRequestParams, HarnessClient, HarnessConfig


class EmptyResponse(BaseModel):
    pass


@pytest.mark.parametrize("outcome", ["allowed-once", "rejected"])
def test_python_approval_controls_runtime_operation(tmp_path: Path, outcome: str) -> None:
    repo = Path(__file__).resolve().parents[3]
    node = shutil.which("node")
    binary = repo / "apps/cli/lib/bin.js"
    if node is None or not binary.exists():
        pytest.skip("requires Node and built dsh CLI")
    fixture = repo / "packages/sdk/server/tests/fixtures/approval.mjs"
    marker = tmp_path / "approved.txt"
    patch = tmp_path / "approval.patch.yml"
    patch.write_text("- insert:\n    - id: approval-fixture\n      name: " + json.dumps(str(fixture))
                     + "\n      config:\n        stopAfterApproval: true\n        path: " + json.dumps(str(marker)) + "\n")
    # The client closes inside the executor lifetime, unblocking a reader even
    # when a regression prevents the expected request from arriving.
    with ThreadPoolExecutor(max_workers=1) as worker:
        with HarnessClient(
            HarnessConfig(cwd=str(repo), request_timeout_seconds=20, shutdown_timeout_seconds=20,
                          env={"DSH_HOME": str(tmp_path / "home"), "DSH_PERMISSION_MODE": "workspace-write",
                               "DSH_TELEMETRY_DISABLED": "1", "DEEPSEEK_API_KEY": "keyless-no-model-call"}),
            _launch_args=(node, str(binary), "--profile", "sdk", "--patch", str(patch)),
        ) as client:
            client.initialize(cwd=str(tmp_path), provider="deepseek-official", model="deepseek-v4-flash",
                              approval_requests=True)
            client.session_prompt("main", [{"type": "text", "text": "Request the marker write."}])
            request = worker.submit(client.next_request).result(timeout=20)
            assert request.method == "approval/request"
            question = ApprovalRequestParams.model_validate(request.payload)
            assert question.sessionId == "main"
            assert question.toolName == "fixture-write"
            client.respond(request.id, {"outcome": outcome})
            client.request("session/wait", {"sessionId": "main"}, response_model=EmptyResponse)
            assert marker.exists() is (outcome == "allowed-once")
            if marker.exists():
                assert marker.read_text() == "approved\n"
