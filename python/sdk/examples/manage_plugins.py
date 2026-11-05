#!/usr/bin/env python3
"""Run a full SDK turn with explicit resource preparation and human permission decisions."""
from __future__ import annotations

import argparse
import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

from deepseek_harness import ApprovalRequestParams, DeepSeekHarness
from deepseek_harness_runtime import download_primary_runtime


def main() -> None:
    """Prepare package tools, answer stdio approvals, and print the final response."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt")
    parser.add_argument("--dsh-home", type=Path, required=True)
    parser.add_argument("--dsh-bin", type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    args = parser.parse_args()
    if os.environ.get("DSH_PRIMARY_RUNTIME") is None:
        download_primary_runtime()
    with ThreadPoolExecutor(max_workers=2) as worker:
        harness = DeepSeekHarness(dsh_home=str(args.dsh_home.resolve()), cwd=str(args.workspace.resolve()),
                                  dsh_bin=None if args.dsh_bin is None else str(args.dsh_bin.resolve()),
                                  approval_requests=True,
                                  env={"DSH_PERMISSION_MODE": "workspace-write"})
        try:
            harness.start()
            run = worker.submit(harness.run, args.prompt)
            request = worker.submit(harness.client.next_request)
            while True:
                ready, _ = wait((run, request), return_when=FIRST_COMPLETED)
                if run in ready:
                    print(run.result().final_response)
                    break
                incoming = request.result()
                if incoming.method == "approval/request":
                    approval = ApprovalRequestParams.model_validate(incoming.payload)
                    print(f"Session {approval.sessionId}, tool {approval.toolName}: {approval.reason or ''}")
                    choice = input("Allow this operation once? [y/N] ").strip().lower()
                    harness.client.respond(incoming.id, {
                        "outcome": "allowed-once" if choice == "y" else "rejected",
                    })
                else:
                    harness.client.respond_error(incoming.id, code=-32601, message="Unsupported client request")
                request = worker.submit(harness.client.next_request)
        finally:
            # Closing first releases the pending next_request before the executor joins its workers.
            harness.close()


if __name__ == "__main__":
    main()
