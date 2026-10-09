"""Raw audit projection paired with the translator's actual native Loader request tests."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness


EXPECTED = Path(__file__).parent / "expected" / "cot-translation-projection.json"


def test_common_translation_records_retain_raw_audit_and_original_main_response(tmp_path: Path) -> None:
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    script = tmp_path / "audit_runtime.py"
    script.write_text(
        """
import json
import os
import sys

def notify(method, params):
    print(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    if message["method"] == "initialize":
        result = {"serverInfo": {"name": "audit-fixture"}}
    elif message["method"] == "session/prompt":
        session_id = message["params"]["sessionId"]
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "agent/inbox/spliced", "seq": 0, "time": 0,
            "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "accepted"}]}}})
        notify("session.status", {"sessionId": session_id, "status": "running"})
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"messageId": "accepted"}}), flush=True)
        notify("session.event", {"sessionId": session_id, "event": {"type": "turn/start", "seq": 1, "time": 0, "data": {"turn": 0}}})
        notify("session.event", {"sessionId": session_id, "event": {"type": "assistant/message", "seq": 2, "time": 0,
            "data": {"message": {"role": "assistant", "content": [{"type": "text", "text": os.environ["MAIN_RESPONSE"]}]}}}})
        for event in json.loads(os.environ["AUDIT_EVENTS"]):
            notify("session.event", {"sessionId": session_id, "event": event})
        notify("session.event", {"sessionId": session_id, "event": {"type": "turn/end", "seq": 5, "time": 0,
            "data": {"turn": 0, "reason": {"kind": "completed"}}}})
        notify("session.status", {"sessionId": session_id, "status": "idle"})
        continue
    elif message["method"] == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}), flush=True)
        break
    else:
        raise RuntimeError("Unexpected protocol method")
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
""".strip(), encoding="utf-8",
    )
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)), cwd=str(tmp_path),
        env={"MAIN_RESPONSE": expected["finalResponse"], "AUDIT_EVENTS": json.dumps(expected["auditEvents"])},
    ) as harness:
        result = harness.run("Keep the original response.", session_id="sdk-audit")
    audit_notifications = [notification for notification in result.notifications
                           if notification.method == "session.event"
                           and notification.payload["event"]["type"] in ("plugin:translator/request", "plugin:translator/result")]
    assert all(notification.payload["sessionId"] == result.session_id for notification in audit_notifications)
    projection = {
        "finalResponse": result.final_response,
        "auditEvents": [event for event in result.events if event["type"] in ("plugin:translator/request", "plugin:translator/result")],
        "auditNotifications": [{"method": notification.method, "event": notification.payload["event"]}
                               for notification in audit_notifications],
        "assistantTexts": [block["text"] for event in result.events if event["type"] == "assistant/message"
                           for block in event["data"]["message"]["content"] if block["type"] == "text"],
    }
    assert projection == expected
    assert len(projection["auditEvents"]) == 2
    for event in projection["auditEvents"]:
        assert "surfaceOp" not in event
        assert "sourceEventSeqs" not in event
