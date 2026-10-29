from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal, TypeAlias

from pydantic import BaseModel, Field, JsonValue as PydanticJsonValue, field_validator

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str | None = None
    version: str | None = None


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo | None = None


class CommandSuccessResult(BaseModel):
    """Successful handler result, optionally linked to a Session event."""

    kind: Literal["success"]
    text: str | None = None
    source_event_seq: int | None = Field(default=None, alias="sourceEventSeq", strict=True, ge=0, le=2**53 - 1)

    @field_validator("text", "source_event_seq", mode="before")
    @classmethod
    def _reject_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("optional command result fields must be omitted instead of null")
        return value


class CommandErrorResult(BaseModel):
    """A command handler's reported failure."""

    kind: Literal["error"]
    text: str

    @field_validator("text")
    @classmethod
    def _non_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("command error text must not be blank")
        return value


CommandResult: TypeAlias = Annotated[CommandSuccessResult | CommandErrorResult, Field(discriminator="kind")]


class CommandExecution(BaseModel):
    """Settled command result and the id pairing its command/run and command/done events."""

    command_id: str = Field(alias="commandId", min_length=1)
    result: CommandResult


class ApprovalRequestParams(BaseModel):
    """Server-to-client approval/request payload after explicit handshake opt-in."""

    sessionId: str
    toolName: str
    callId: str | None = None
    reason: str | None = None


class ApprovalRequestResult(BaseModel):
    """One-operation decision; allowed-once is the only grant."""

    outcome: Literal["allowed-once", "rejected", "cancelled"]

class UserQuestionRequest(BaseModel):
    """Runtime question batch; questions retain their options, detail, and presentation intent."""

    request_id: str = Field(alias="requestId", min_length=1)
    session_id: str = Field(alias="sessionId")
    questions: list[dict[str, PydanticJsonValue]] = Field(min_length=1)


class UserQuestionAnswerItem(BaseModel):
    """Answer to one original question id, using selected labels or custom text."""

    id: str
    selected: list[str]
    custom: str | None = None


class UserQuestionAnswer(BaseModel):
    """One answer per original question; an empty batch is not an implicit approval."""

    answers: list[UserQuestionAnswerItem]
