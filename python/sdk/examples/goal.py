#!/usr/bin/env python3
"""Set a goal and observe automatic rounds through the final model reply."""

from __future__ import annotations

import argparse
import math
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

from deepseek_harness import DeepSeekHarness, Notification
from deepseek_harness.api import final_response


def display(notification: Notification) -> dict | None:
    """Print durable assistant output and return the observed root Session event."""
    if notification.method != "session.event":
        return None
    event = notification.payload["event"]
    if event["type"] == "assistant/message":
        text = final_response([event])
        if text:
            print(text, flush=True)
    elif event["type"] == "goal/change":
        print(f"Goal: {event['data']['operation']}", flush=True)
    elif event["type"] == "turn/end" and event["data"]["reason"]["kind"] != "completed":
        raise RuntimeError(f"Goal activity ended: {event['data']['reason']}")
    return event


def main() -> None:
    """Observe goal state before waiting for the final activity interval."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--timeout-seconds", type=float, default=300)
    parser.add_argument("objective", help="Objective for the native /goal command")
    args = parser.parse_args()
    if not args.objective.strip() or not math.isfinite(args.timeout_seconds) or args.timeout_seconds <= 0:
        parser.error("objective must be non-blank and timeout-seconds must be finite and positive")
    with DeepSeekHarness(
        dsh_home=str(args.dsh_home.resolve()), cwd=str(args.workspace.resolve()),
        profile="sdk", model=args.model, env={"DSH_PERMISSION_MODE": "workspace-write"},
    ) as harness:
        session = harness.start_session()
        with ThreadPoolExecutor(max_workers=1) as worker:
            running = worker.submit(
                session.run, f"/goal {args.objective}",
                on_notification=lambda notice: display(notice) if notice.payload.get("sessionId") == session.id else None,
            )
            try:
                result = running.result(timeout=args.timeout_seconds)
            except FutureTimeoutError as error:
                raise TimeoutError("Goal observation timed out") from error
            finally:
                if not running.done():
                    harness.close()
        if result.finish_reason != "completed":
            raise RuntimeError(f"Goal activity ended with {result.finish_reason}: {result.final_response}")


if __name__ == "__main__":
    main()
