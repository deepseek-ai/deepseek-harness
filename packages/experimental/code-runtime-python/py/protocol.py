"""Wire protocol vocabulary for the Python side of dsh-code-runtime-python.

Mirrors ``src/protocol.ts``. Frames travel on fd 3 as JSON-lines (one JSON
object per line). The host validates every inbound frame; this side trusts
host replies.

The wire uses the JSON key ``global`` (a Python keyword), so the frame
``TypedDict``s that carry it are declared with the functional syntax rather than
class bodies: a class attribute cannot be named ``global``, and a ``global_``
attribute would describe a key the wire never sends. Optional-field messages
pair a required base with a ``total=False`` subclass so a required field such as
``type`` cannot be dropped while ``value``/``error``/``truncated`` stay optional.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union

# The protocol fd from the child's perspective. Node passes
# ``stdio: [pipe, pipe, pipe, pipe]`` so the fourth entry (fd 3) is the
# framed-JSON channel; stdout/stderr stay clear for the program's own output.
PROTOCOL_FD = 3


class ErrorClass(TypedDict):
    """A namespace's program-visible exception class: rejected calls raise its
    instances carrying the failed member name on ``memberNameProperty``."""

    name: str
    memberNameProperty: str


# ``global`` is a Python keyword, so the required part is declared functionally
# to hold the real wire key; ``errorClass`` is optional per the TS `errorClass?`.
_NamespaceRequired = TypedDict("_NamespaceRequired", {"global": str, "names": "list[str]"})


class Namespace(_NamespaceRequired, total=False):
    """One binding namespace declaration: the ``global`` name, its function
    ``names``, and an optional program-visible ``errorClass`` for rejected calls."""

    errorClass: ErrorClass


class BootMessage(TypedDict):
    """Host → child, first frame on fd 3. Carries every cap and the namespaces."""

    type: Literal["boot"]
    cpuSeconds: int
    addressSpaceBytes: int
    maxLogBytes: int
    maxValueBytes: int
    namespaces: "list[Namespace]"


class RunMessage(TypedDict):
    """Host → child, sent after ``boot-ack``. Carries only the program body."""

    type: Literal["run"]
    program: str


class BootAckMessage(TypedDict):
    """Child → host: resource limits applied, ready for the run message."""

    type: Literal["boot-ack"]


# ``global`` wire key: whole message declared functionally, all fields required.
CallMessage = TypedDict(
    "CallMessage",
    {"type": Literal["call"], "id": int, "global": str, "name": str, "args": Any},
)


_LogMessageRequired = TypedDict("_LogMessageRequired", {"type": Literal["log"], "text": str})


class LogMessage(_LogMessageRequired, total=False):
    """Child → host: one captured text chunk, streamed eagerly.

    ``truncated`` is set only on the frame that IS the child ledger's truncation
    marker (not program output), so the host stops capturing at the same point
    the child did — mirrors the TS `truncated?`. ``open`` is set on a flushed unterminated line the host appends the next frame to (mirrors `open?`).
    """

    truncated: bool
    open: bool


class DoneErrorField(TypedDict):
    """Child → host: the failure carried on a ``done`` frame. ``kind`` is one of
    the three the host validates; ``message`` is the traceback or diagnostic."""

    kind: Literal["exception", "invalid-output", "output-limit"]
    message: str


_DoneMessageRequired = TypedDict("_DoneMessageRequired", {"type": Literal["done"]})


class DoneMessage(_DoneMessageRequired, total=False):
    """Child → host: the program settled. ``value`` and ``error`` are optional per the TS mirror."""

    value: Any
    error: DoneErrorField


ChildToHost = Union[BootAckMessage, CallMessage, LogMessage, DoneMessage]


class ReplyOk(TypedDict):
    type: Literal["reply"]
    id: int
    ok: Literal[True]
    value: Any


class ReplyErr(TypedDict):
    type: Literal["reply"]
    id: int
    ok: Literal[False]
    message: str


ReplyMessage = Union[ReplyOk, ReplyErr]
# The host sends ``boot`` and ``run`` before any ``reply``, so the child-facing
# inbound union covers all three, not replies alone.
HostToChild = Union[BootMessage, RunMessage, ReplyMessage]


def log_truncation_marker(max_bytes: int) -> str:
    """Return the in-band marker for a log ledger that exhausted its budget.

    Byte-identical text on both sides of the wire so a truncated run reads the
    same however the cap was hit.
    """

    return f"[dsh-code-runtime-python] log capture truncated at {max_bytes} bytes"
