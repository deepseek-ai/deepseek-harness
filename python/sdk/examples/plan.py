#!/usr/bin/env python3
"""Submit a plan command, review its plan, and observe the Session's continuing work."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
from pathlib import Path

from deepseek_harness import DeepSeekHarness, Notification, UserQuestionRequest
from deepseek_harness.api import final_response


class _PlanReviews:
    """Own cancellable readers with the parent's stdin encoding and join review callbacks before exit."""

    # A buffered reader can consume later answers from a pipe before it exits.
    _READ_LINE = """import codecs, os, sys
sys.stdin.reconfigure(encoding=sys.argv[1])
if sys.stdin.isatty():
    try:
        text = input() + '\\n'
    except EOFError:
        text = ''
else:
    decoder = codecs.getincrementaldecoder(sys.stdin.encoding or 'utf-8')()
    line = []
    while True:
        value = os.read(0, 1)
        decoded = decoder.decode(value, final=not value)
        if decoded:
            line.append(decoded)
        if not value or '\\n' in decoded:
            break
    text = ''.join(line)
sys.stdout.buffer.write(text.encode('utf-8'))
"""

    def __init__(self) -> None:
        self._closed = threading.Event()
        self._lock = threading.Lock()
        self._question_lock = threading.Lock()
        self._readers: list[subprocess.Popen[bytes]] = []
        self._callbacks: set[threading.Thread] = set()

    def __enter__(self) -> _PlanReviews:
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        with self._lock:
            self._closed.set()
            readers = tuple(self._readers)
            callbacks = tuple(self._callbacks)
        for reader in readers:
            self._terminate(reader)
        for reader in readers:
            reader.wait()
        for callback in callbacks:
            if callback is not threading.current_thread():
                callback.join()

    @staticmethod
    def _terminate(reader: subprocess.Popen[bytes]) -> None:
        if reader.poll() is None:
            try:
                reader.kill()
            except ProcessLookupError as error:
                # The reader exited between poll and kill.
                pass

    def _read_line(self, prompt: str, cancelled: threading.Event) -> str | None:
        with self._lock:
            if self._closed.is_set() or cancelled.is_set():
                return None
            reader = subprocess.Popen(
                [sys.executable, "-c", self._READ_LINE, sys.stdin.encoding or "utf-8"], stdin=sys.stdin,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self._readers.append(reader)
        try:
            print(prompt, end="", flush=True)
            while True:
                if self._closed.is_set() or cancelled.is_set():
                    self._terminate(reader)
                try:
                    output, errors = reader.communicate(timeout=0.05)
                    break
                except subprocess.TimeoutExpired:
                    continue
            if self._closed.is_set() or cancelled.is_set():
                return None
            if reader.returncode != 0:
                raise RuntimeError(f"Plan review input reader failed: {errors.decode(errors='replace').strip()}")
            return output.decode("utf-8").removesuffix("\n").removesuffix("\r") if output else None
        finally:
            self._terminate(reader)
            reader.communicate()
            with self._lock:
                self._readers.remove(reader)

    def answer(self, request: UserQuestionRequest, cancelled: threading.Event) -> dict:
        """Serialize plan reviews; cancellation or empty stdin dismisses the current question."""
        with self._lock:
            if self._closed.is_set() or cancelled.is_set():
                return {"cancelled": True}
            self._callbacks = {callback for callback in self._callbacks if callback.is_alive()}
            self._callbacks.add(threading.current_thread())
        while not self._question_lock.acquire(timeout=0.05):
            if self._closed.is_set() or cancelled.is_set():
                return {"cancelled": True}
        try:
            if self._closed.is_set() or cancelled.is_set():
                return {"cancelled": True}
            if len(request.questions) != 1 or request.questions[0].get("intent", {}).get("kind") != "plan-review":
                raise RuntimeError("This example handles plan reviews only")
            question = request.questions[0]
            print(question["detail"], flush=True)
            while True:
                choice = self._read_line("[a] Approve, [k] Keep planning, [d] Dismiss: ", cancelled)
                if choice is None or choice.strip().lower() == "d":
                    return {"cancelled": True}
                if choice.strip().lower() == "a":
                    return {"answers": [{"id": question["id"], "selected": ["Approve"]}]}
                if choice.strip().lower() == "k":
                    feedback = self._read_line("Feedback: ", cancelled)
                    if feedback is None:
                        return {"cancelled": True}
                    return {"answers": [{"id": question["id"], "selected": ["Keep planning"], "custom": feedback}]}
        finally:
            self._question_lock.release()


def display(notification: Notification, session_id: str) -> None:
    """Print assistant text and report an unsuccessful root Session turn."""
    if notification.method == "session.event":
        event = notification.payload.get("event")
        if isinstance(event, dict) and event.get("type") == "assistant/message":
            text = final_response([event])
            if text:
                print(text)
        elif (isinstance(event, dict) and event.get("type") == "turn/end"
              and notification.payload.get("sessionId") == session_id):
            reason = event["data"]["reason"]
            if reason["kind"] != "completed":
                raise RuntimeError(f"Agent turn ended: {reason}")


def main() -> None:
    """Keep the runtime and question handler alive until the plan activity finishes."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-home", required=True, type=Path)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("task", help="Task to plan; implementation waits for your approval")
    args = parser.parse_args()
    if not args.task.strip():
        parser.error("task must be non-blank")
    with _PlanReviews() as reviews, DeepSeekHarness(
        dsh_home=str(args.dsh_home.resolve()), cwd=str(args.workspace.resolve()),
        profile="sdk", model=args.model, on_user_question=reviews.answer,
        env={"DSH_PERMISSION_MODE": "workspace-write"},
    ) as harness:
        session = harness.start_session()
        result = session.run(f"/plan {args.task}", on_notification=lambda notice: display(notice, session.id))
        if result.finish_reason != "completed":
            raise RuntimeError(f"Plan activity ended with {result.finish_reason}: {result.final_response}")


if __name__ == "__main__":
    main()
