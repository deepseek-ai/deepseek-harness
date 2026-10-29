from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

from .client import HarnessClient, HarnessConfig, UserQuestionHandler
from .errors import SdkProtocolError
from .models import CommandExecution, JsonObject, Notification


@dataclass(slots=True)
class DeepSeekHarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime.

    The runtime inherits the caller's environment by default, so existing
    DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL settings keep working. Use ``env`` to
    intentionally override or inject variables for a subprocess.
    These values are startup input, not a live Session state mirror; Session
    commands do not rewrite this object.
    """

    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    reasoning_effort: str | None = None
    max_tokens: int | None = None
    cwd: str | None = None
    runtime_cwd: str | None = None
    dsh_bin: str | None = None
    profile: str = "sdk"
    patches: tuple[str, ...] = ()
    dsh_home: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    initialize_timeout_seconds: float = 30.0
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float | None = 1.0
    base_url: str | None = None
    api_key: str | None = None
    on_user_question: UserQuestionHandler | None = None
    approval_requests: bool = False


@dataclass(slots=True)
class RunResult:
    """Completed input with result text, outcome, root events and Session-tree notifications."""

    session_id: str
    final_response: str
    """Final assistant text (empty when absent), native state-only result text, or a failure diagnostic."""
    finish_reason: str | None
    events: list[JsonObject]
    notifications: list[Notification]


class _RunActivity:
    """Collect one input's root events and Session-tree notifications from its admission."""

    def __init__(self, session_id: str, receipt_kind: Literal["prompt", "command"], receipt_id: str) -> None:
        self.session_id = session_id
        self.receipt_kind = receipt_kind
        self.receipt_id = receipt_id
        self.received = False
        self.command_done = False
        self.events: list[JsonObject] = []
        self.notifications: list[Notification] = []

    def record(self, notification: Notification, on_notification: Callable[[Notification], None] | None = None) -> bool:
        if notification.method == "session.query.completed":
            return False
        if not self.received:
            if self.receipt_kind == "prompt":
                if not _is_inbox_receipt(notification, self.session_id, self.receipt_id):
                    return False
            elif not _is_command_event(notification, self.session_id, self.receipt_id, "command/run"):
                return False
            self.received = True
        event = notification.payload.get("event") if (
            notification.method == "session.event" and notification.payload.get("sessionId") == self.session_id
        ) else None
        if (self.receipt_kind == "command" and isinstance(event, dict) and event.get("type") == "command/done"
                and isinstance(event.get("data"), dict) and event["data"].get("commandId") == self.receipt_id):
            self.command_done = True
        self.notifications.append(notification)
        if on_notification is not None:
            on_notification(notification)
        if isinstance(event, dict):
            self.events.append(event)
        return True

    def result(self, completed: JsonObject | None = None) -> RunResult:
        if completed is not None and not self.command_done:
            raise SdkProtocolError("Command completion is missing matching lifecycle events")
        return RunResult(
            session_id=self.session_id,
            final_response=completed["finalResponse"] if completed is not None else final_response(self.events),
            finish_reason=completed["finishReason"] if completed is not None else finish_reason(self.events),
            events=self.events, notifications=self.notifications,
        )


class DeepSeekHarness:
    """Reusable synchronous SDK for running DeepSeek Harness agent turns.

    The runtime subprocess starts lazily and remains owned by this instance
    across calls to :meth:`run`. Use the instance as a context manager, or call
    :meth:`close` explicitly when finished, so the subprocess is always reaped.
    """

    def __init__(
        self,
        config: DeepSeekHarnessConfig | None = None,
        *,
        _launch_args: tuple[str, ...] | None = None,
        **kwargs: object,
    ) -> None:
        if config is not None and kwargs:
            raise TypeError("pass either DeepSeekHarnessConfig or keyword options, not both")
        self.config = config or DeepSeekHarnessConfig(**kwargs)
        cwd = str(Path(self.config.cwd or Path.cwd()).resolve())
        runtime_cwd = str(Path(self.config.runtime_cwd).resolve()) if self.config.runtime_cwd is not None else cwd
        self._cwd = cwd
        env = dict(self.config.env)
        if self.config.base_url is not None:
            env["DEEPSEEK_BASE_URL"] = self.config.base_url
        if self.config.api_key is not None:
            env["DEEPSEEK_API_KEY"] = self.config.api_key

        self._client = HarnessClient(
            HarnessConfig(
                dsh_bin=self.config.dsh_bin,
                profile=self.config.profile,
                patches=self.config.patches,
                dsh_home=self.config.dsh_home,
                cwd=runtime_cwd,
                env=env,
                initialize_timeout_seconds=self.config.initialize_timeout_seconds,
                request_timeout_seconds=self.config.request_timeout_seconds,
                shutdown_timeout_seconds=self.config.shutdown_timeout_seconds,
                on_user_question=self.config.on_user_question,
            ),
            _launch_args=_launch_args,
        )
        self._initialized = False

    def __enter__(self) -> "DeepSeekHarness":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    @property
    def client(self) -> HarnessClient:
        return self._client

    def start(self) -> None:
        if self._initialized:
            return
        self._client.start()
        self._client.initialize(
            cwd=self._cwd,
            provider=self.config.provider,
            model=self.config.model,
            reasoning_effort=self.config.reasoning_effort,
            max_tokens=self.config.max_tokens,
            approval_requests=self.config.approval_requests,
        )
        self._initialized = True

    def close(self) -> None:
        self._client.close()
        self._initialized = False

    def start_session(self, session_id: str | None = None) -> "Session":
        self.start()
        return Session(self, session_id or f"session-{uuid.uuid4().hex}")

    def resume_session(self, session_id: str) -> "Session":
        """Restore persisted history from the configured Harness home without sending input.

        Missing, unreadable, incompatible, or occupied sessions raise instead of creating a new session.
        """
        self.start()
        self._client.resume_session(session_id)
        return Session(self, session_id)

    def run(
        self,
        input: str | list[JsonObject],
        *,
        session_id: str | None = None,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        """Run input to completion on a fresh or named Session and return its RunResult."""
        return self.start_session(session_id).run(input, on_notification=on_notification)


class Session:
    def __init__(self, harness: DeepSeekHarness, session_id: str) -> None:
        self.harness = harness
        self.id = session_id

    def get_working_directory(self) -> str:
        """Read the effective directory, recovering a missing directory to the Session origin."""
        self.harness.start()
        return self.harness.client.get_working_directory(self.id)

    def set_working_directory(self, path: str) -> str:
        """Change the effective directory while existing processes retain their own directories."""
        self.harness.start()
        return self.harness.client.set_working_directory(self.id, path)

    def run(
        self,
        input: str | list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        """Run text or content blocks through native input routing.

        Ordinary prompts finish at the next idle after their inbox receipt.
        State-only commands finish with their native outcome. Commands that
        submit model input wait for that activity; goal creation and resume wait
        through automatic rounds and the last reply after the goal stops.
        The first text block selects native commands. Matched commands require
        one text block with only encoded images beside it; native handlers decide
        which commands accept those images. Ordinary prompts retain block order
        and are queued through the existing prompt operation. Notifications retain
        wire order. Every result retains this Session id, its root events and
        Session-tree notifications, including overlapping work. Native refusals
        return finish_reason="error". Routing, transport and observer failures
        raise without rolling back work.
        """
        self.harness.start()
        with self.harness.client.subscribe_session_notifications(self.id) as subscription:
            response = self.harness.client._query(self.id, input)
            if isinstance(response, CommandExecution):
                activity = _RunActivity(self.id, "command", response.command_id)
                while True:
                    notification = subscription.next()
                    payload = notification.payload
                    if notification.method == "session.query.completed" and payload.get("sessionId") == self.id:
                        if not isinstance(payload.get("commandId"), str) or not payload["commandId"]:
                            raise SdkProtocolError("Invalid session.query.completed command identity")
                        if payload["commandId"] != response.command_id:
                            continue
                        if (not isinstance(payload.get("finalResponse"), str)
                                or not isinstance(payload.get("finishReason"), str) or not payload["finishReason"]):
                            raise SdkProtocolError("Invalid session.query.completed result")
                        # Failure completion can precede handler settlement; its lifecycle precedes the RPC response.
                        while not activity.command_done:
                            try:
                                queued = subscription.next(timeout_seconds=0)
                            except TimeoutError:
                                break
                            activity.record(queued, on_notification)
                        return activity.result(payload)
                    activity.record(notification, on_notification)
            activity = _RunActivity(self.id, "prompt", response)
            while True:
                notification = subscription.next()
                if not activity.record(notification, on_notification):
                    continue
                if (
                    notification.method == "session.status"
                    and notification.payload.get("sessionId") == self.id
                    and notification.payload.get("status") == "idle"
                ):
                    break

        return activity.result()


def _is_inbox_receipt(notification: Notification, session_id: str, message_id: str) -> bool:
    if notification.method != "session.event" or notification.payload.get("sessionId") != session_id:
        return False
    event = notification.payload.get("event")
    if not isinstance(event, dict) or event.get("type") != "agent/inbox/spliced":
        return False
    data = event.get("data")
    inserted = data.get("inserted") if isinstance(data, dict) else None
    return isinstance(inserted, list) and any(
        isinstance(message, dict) and message.get("id") == message_id for message in inserted
    )


def _is_command_event(notification: Notification, session_id: str, command_id: str, event_type: str) -> bool:
    if notification.method != "session.event" or notification.payload.get("sessionId") != session_id:
        return False
    event = notification.payload.get("event")
    if not isinstance(event, dict) or event.get("type") != event_type:
        return False
    data = event.get("data")
    return isinstance(data, dict) and data.get("commandId") == command_id


def final_response(events: list[JsonObject]) -> str:
    for event in reversed(events):
        if event.get("type") != "assistant/message":
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        message = data.get("message")
        content_owner = message if isinstance(message, dict) else data
        content = content_owner.get("content")
        if not isinstance(content, list):
            continue
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "".join(parts)
    return ""


def finish_reason(events: list[JsonObject]) -> str | None:
    """Return the last turn-ending kind.

    The input must contain root-session events from one owned run interval.

    Raises:
        SdkProtocolError: The last ``turn/end`` has no string reason kind.
    """
    for event in reversed(events):
        if event.get("type") != "turn/end":
            continue
        data = event.get("data")
        reason = data.get("reason") if isinstance(data, dict) else None
        kind = reason.get("kind") if isinstance(reason, dict) else None
        if not isinstance(kind, str):
            raise SdkProtocolError("turn/end event requires a string data.reason.kind")
        return kind
    return None
