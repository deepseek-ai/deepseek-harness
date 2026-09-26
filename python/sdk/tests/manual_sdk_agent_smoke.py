"""Drive the repo-source dsh SDK profile through the SDK and a keyless mock SSE server.

Requires ``pnpm install`` but no build. This manual test is not collected by
pytest; run ``python tests/manual_sdk_agent_smoke.py``.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from deepseek_harness import DeepSeekHarness


class MockCompletionHandler(BaseHTTPRequestHandler):
    requests: list[dict[str, Any]] = []

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        self.requests.append({
            "path": self.path,
            "api_key": self.headers.get("x-api-key"),
            "body": json.loads(body),
        })
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        events = [
            {"type": "message_start", "message": {"id": "sdk-smoke", "model": "sdk-smoke-model", "usage": {"input_tokens": 7, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "SDK runtime reached the configured HTTP model endpoint."}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 9}},
            {"type": "message_stop"},
        ]
        for event in events:
            self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())

    def log_message(self, _format: str, *_args: object) -> None:
        return


def run_smoke(repo_root: Path, keep_sessions: bool) -> None:
    dsh_home = Path(tempfile.mkdtemp(prefix="dsh-sdk-smoke-home-"))
    session_root = dsh_home / "sessions"
    runtime_entry = repo_root / "apps/cli/src/bin.ts"
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockCompletionHandler)
    thread = threading.Thread(target=server.serve_forever, name="mock-messages-server", daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"

    print(f"repo_root={repo_root}")
    print(f"dsh_home={dsh_home}")
    print(f"mock_base_url={base_url}")

    try:
        with DeepSeekHarness(
            model="sdk-smoke-model",
            cwd=str(repo_root / "python/sdk"),
            runtime_cwd=str(repo_root),
            _launch_args=(
                "node",
                "--import",
                "tsx",
                str(runtime_entry),
                "--profile",
                "sdk",
            ),
            env={
                "DSH_HOME": str(dsh_home),
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
                "DEEPSEEK_BASE_URL": base_url,
                "DEEPSEEK_API_KEY": "sdk-smoke-key",
            },
            request_timeout_seconds=20,
            shutdown_timeout_seconds=2,
        ) as harness:
            result = harness.run(
                "Please reply with a short confirmation and do not call tools.",
                session_id="sdk-smoke-main",
            )
        print(f"final_response={result.final_response}")
        assert "configured HTTP model endpoint" in result.final_response
        assert len(MockCompletionHandler.requests) == 1
        request = MockCompletionHandler.requests[0]
        print(json.dumps(request, ensure_ascii=False, indent=2)[:4000])
        assert request["path"] == "/v1/messages"
        assert request["api_key"] == "sdk-smoke-key"
        assert request["body"]["model"] == "sdk-smoke-model"

        jsonl_files = sorted(session_root.rglob("*.jsonl.zstd"))
        assert jsonl_files, f"no Zstandard JSONL sessions were written under {session_root}"
        print("session_jsonl_zstd_files:")
        for path in jsonl_files:
            print(f"  {path} bytes={path.stat().st_size}")
            assert path.read_bytes().startswith(bytes.fromhex("28b52ffd"))
    finally:
        server.shutdown()
        server.server_close()

    if keep_sessions:
        print(f"kept_dsh_home={dsh_home}")
    else:
        shutil.rmtree(dsh_home)
        print("removed temporary dsh home")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
        help="Path to the deepseek-harness checkout.",
    )
    parser.add_argument("--keep-sessions", action="store_true")
    args = parser.parse_args()
    run_smoke(args.repo_root.resolve(), args.keep_sessions)


if __name__ == "__main__":
    main()
