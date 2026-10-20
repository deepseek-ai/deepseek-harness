from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from pydantic import BaseModel, Field, JsonValue as PydanticJsonValue

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
