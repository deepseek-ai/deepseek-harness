"""CPython bootstrap for dsh-code-runtime-python.

Reads a :class:`BootMessage` on fd 3, applies resource limits and log capture,
reads a :class:`RunMessage`, runs the model program as the body of an async
function (top-level ``await`` and ``return`` both work; the returned value is
the completion), and posts a terminal :class:`DoneMessage`. The program calls
host functions through the ``tools`` (or other namespace) proxy, whose attribute
and subscript access return awaitables that ride binding messages over fd 3.

This module runs under ``python3 -I`` with only ``TMPDIR`` in its environment
and ``sys.path`` containing only its own directory.
"""

from __future__ import annotations

import asyncio
import ast
import io
import json
import math
import os
import re
import resource
import signal
import sys
import threading
import traceback
from decimal import Context, Decimal

# The float encoder must NOT depend on the process-global decimal context: a
# legitimate program may set `getcontext().prec = 2` (silently rounding the
# completion value's digits) or `traps[Inexact] = True` (making the encode
# raise, misclassifying a successful run as an exception). A fixed context with
# prec=28 (more than the 17 significant digits a double needs) makes the
# normalize() spelling decision context-independent.
_FLOAT_CONTEXT = Context(prec=28)
from pathlib import Path
from typing import Any

# ``python3 -I`` (isolated) drops the script directory from ``sys.path`` so
# the sibling ``protocol.py`` is invisible by default. Restore it explicitly
# before importing.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from protocol import PROTOCOL_FD, log_truncation_marker  # noqa: E402

# Read size for the async fd-3 reader. One `os.read` returns whatever the pipe
# holds, so this only bounds a single syscall's copy, not a frame: a larger frame
# simply takes more reads. 64 KiB matches the usual pipe capacity.
_READ_CHUNK_BYTES = 65536

# Module-level captures for the done-frame LAST-resort fallback. This bootstrap IS
# ``__main__``, so ``import __main__; __main__.os = ...`` would rebind ``os.write``
# at call time inside ``ProtocolChannel.write_encoded``. These module-level names
# are the RAW primitive for the fallback; they are BOUND INTO ``_run`` LOCALS
# before the program runs (see ``send_done``), which is what makes a one-line
# rebind unable to change which write the fallback uses — the module global here
# is itself reachable by ``__main__._os_write = boom``, so the immunity lives in
# the ``_run`` frame-local binding, not in the module global.
_os_write = os.write
_memoryview = memoryview

# A fixed, pre-encoded done frame for the fallback. It carries no live model
# value, so it can always be written even when a transitive name (a ``_dump_*``
# helper or ``os``) has been rebound and the normal encode/write threw. The
# message is the fixed literal ``<unrenderable>`` — distinct from the failure
# reporter's ``_UNRENDERABLE_DIAGNOSTIC`` text; the host renders the run as an
# exception rather than a worker-exit, which is the honest verdict for a settled
# run whose reporting was sabotaged. The bytes are JSON-valid and
# newline-terminated.
_FALLBACK_DONE_FRAME = b'{"type":"done","error":{"kind":"exception","message":"<unrenderable>"}}\n'

# Code-unit ceiling on the exception class name interpolated into the LAST-resort
# failure diagnostic. A metaclass `__name__` property can return any length, and
# that construction runs outside the guard that would otherwise absorb a
# MemoryError, so the name is sliced before it is copied. Generous enough that no
# real class name is touched.
_MAX_FALLBACK_NAME_CHARS = 200

# Mirror of the host's output-budget/address-space gate (src/index.ts's
# OUTPUT_BUDGET_WORST_CASE_ADDRESS_SPACE_MULTIPLE and INTERPRETER_BASELINE_BYTES),
# re-applied against the EFFECTIVE RLIMIT_AS after inheritance clamping. An astral
# character is one character but ~4 bytes of str storage and ~4 UTF-8 bytes, and
# three such copies are live at the peak — the caller's write argument, the line
# slice or joined pending handed to push, and the encode copy push takes — so a
# budget's worst-case peak is twelve times its byte count; the interpreter's own
# footprint is reserved on top. Kept in sync with the host constants by the shared
# reasoning, not a wire field.
_OUTPUT_BUDGET_WORST_CASE_MULTIPLE = 12
_INTERPRETER_BASELINE_BYTES = 64 * 1024 * 1024


# ---------------------------------------------------------------------------
# Log buffer — Python-side ledger for captured text.
# ---------------------------------------------------------------------------


class LogBuffer:
    """Ordered text capture under one shared byte budget.

    Once the budget is exhausted the buffer emits exactly one in-band
    truncation marker via ``sink`` and silently drops everything after. The
    cap is a blast-radius bound; "how much was lost" intentionally stays
    unmeasured.
    """

    def __init__(self, max_bytes: int, sink) -> None:
        self._max_bytes = max_bytes
        # The ledger starts one byte below max_bytes: each entry is charged its
        # JSON-string cost plus one separator byte, and the serialized outer
        # logs array adds one more byte of envelope (two brackets and n-1 commas
        # over n entries' separators), so a result that exactly exhausts the
        # ledger serializes to exactly max_bytes; WITHOUT the reserved byte it
        # would serialize to max_bytes + 1. Reserving that byte keeps an
        # admitted result within the configured cap; the truncation-marker entry
        # is envelope, not payload, and rides uncharged (``_max_bytes`` stays the
        # configured value for the marker's message text).
        self._remaining = max_bytes - 1
        self._truncated = False
        # True while an `open` (unterminated-flush) entry is being accumulated:
        # continuation fragments bill only their CONTENT (no quotes — they ride
        # on the first fragment — and no separator), so a merged entry's wire
        # cost is billed exactly once, split across its fragments, matching the
        # host ledger.
        self._open_started = False
        # Re-entrant so a caller may hold it across a compound read-modify-write
        # (``_LogStream.write`` reads ``remaining`` several times and then calls
        # ``push`` while still holding it). One lock is shared by this buffer and
        # every stream that funnels into it: model code may start daemon threads
        # that keep calling ``print`` after the program body returns, and the
        # settlement ``flush_line`` on the main coroutine reads and mutates the
        # same ``_pending``/ledger state. Without a shared lock the flush could
        # interleave with a concurrent ``write`` — dropping or double-counting a
        # line, or costing the ``done`` frame on a mangled ledger. Fixing which
        # callable runs (binding ``out_stream.flush_line``) does not fix what it
        # reads.
        self._lock = threading.RLock()
        # ``sink(text, truncated=False)``. The marker is emitted with
        # ``truncated=True`` so the host can stop its own capture at the same
        # point rather than treating the marker as ordinary program output: the
        # two ledgers exhaust independently, and one entry larger than
        # ``max_bytes`` sends only the marker while the host budget is still
        # nearly empty.
        self._sink = sink

    @property
    def lock(self) -> "threading.RLock":
        """The shared re-entrant lock guarding this ledger and its streams' buffers."""

        return self._lock

    @property
    def remaining(self) -> int:
        """Serialized bytes still admissible; zero once truncated (streams use this to bound their own buffering, where a character count is a valid lower bound)."""

        return 0 if self._truncated else self._remaining

    def push(self, text: str, open: bool = False) -> None:
        with self._lock:
            self._push_locked(text, open)

    def _push_locked(self, text: str, open: bool = False) -> None:
        if self._truncated:
            return
        # Cheap lower bound FIRST: one char is at least one UTF-8 byte and the
        # JSON form adds two quotes plus the separator, so a single print() far
        # above the budget truncates without ever encoding it — the full encode
        # would allocate a second equally large string and could turn a
        # truncatable log into an RLIMIT_AS death.
        if (len(text) + 3 if not self._open_started else len(text)) > self._remaining:
            self._truncated = True
            self._sink(log_truncation_marker(self._max_bytes), truncated=True)
            return
        # A model print() can emit a lone surrogate; strict UTF-8 throws on it
        # here. Replace it rather than escaping it the way :func:`_dump_string`
        # preserves one inside a completion VALUE: log text is already a
        # truncatable, substituting channel (the byte cap replaces the tail with
        # a marker), and the ledger below charges the RAW UTF-8 bytes, which
        # would undercharge the six-byte escape by half. Bounded: the text
        # passed the length check, so this encodes at most ~4x remaining.
        try:
            raw = text.encode("utf-8")
        except UnicodeEncodeError:
            raw = text.encode("utf-8", errors="replace")
            text = raw.decode("utf-8")
        # Charge the SERIALIZED cost — the JSON string form's bytes plus one
        # separator byte — exactly as the host ledger does. Charging the raw
        # UTF-8 length instead undercharges control-heavy text, whose JSON
        # escaping expands it up to sixfold (a NUL costs one raw byte but six
        # as its ``\uXXXX`` escape): a NUL flood sized to fit ``maxLogBytes``
        # raw would serialize to roughly six times the shared cap, and the child
        # could then die on RLIMIT_AS (reported host-side as ``worker-exit``)
        # instead of emitting the truncation marker. The +1 also floors an empty
        # entry above zero, so a flood of blank ``print()`` lines exhausts the
        # budget instead of emitting unbounded zero-cost log frames.
        # Split billing for a merged entry: the FIRST fragment pays the full
        # JSON-string cost plus the separator; every later fragment — a
        # continuation OR the closing frame (it is the merged entry's tail, not
        # a new entry) — pays only its content, since the quotes and separator
        # were billed on the first fragment. A standalone closed entry (no open
        # in progress) pays the full cost as before.
        if self._open_started:
            cost = _json_string_cost(raw) - 2
            if cost < 0:
                cost = 0
        else:
            cost = _json_string_cost(raw) + 1
        if cost > self._remaining:
            self._truncated = True
            self._sink(log_truncation_marker(self._max_bytes), truncated=True)
            return
        self._remaining -= cost
        if open:
            self._open_started = True
        else:
            self._open_started = False
        self._sink(text, open=open)


class _LogStream(io.TextIOBase):
    """A newline-coalescing text stream backed by a :class:`LogBuffer`.

    Installed as ``sys.stdout`` / ``sys.stderr`` before executing the model
    program. ``print(...)`` calls ``write`` once per argument, separator, and
    newline, so a raw one-push-per-write stream would emit
    ``["a", " ", "b", "\\n"]`` for ``print("a", "b")`` — and PTC mode renders
    ``logs`` with ``join('\\n')``, turning that into spurious blank lines. This
    stream instead buffers writes and pushes one LogBuffer entry per completed
    LINE (the text up to each ``\\n``, newline stripped), so the rendered join
    reproduces ``a b``. Any unterminated tail is flushed by :meth:`flush_line`
    after the program settles.
    """

    def __init__(self, logs: LogBuffer) -> None:
        super().__init__()
        self._logs = logs
        # list-of-chunks, joined only at a newline or flush: repeated
        # ``print("x", end="")`` must not concatenate quadratically.
        self._pending: list[str] = []
        self._pending_blocks: list[str] = []
        self._pending_chars = 0
        # A newline-free drip must not accumulate one list slot per ``write``:
        # under a large ``maxLogBytes`` the list-of-fragments pointer array and
        # the per-fragment str objects cost host memory well before the byte
        # budget is reached, and a 25 M single-character drip would OOM on its
        # own accounting (plus the same-size list ``_push_bounded_prefix`` then
        # builds). Past this many fragments the chunks are SEALED into a
        # ``_pending_blocks`` entry (the character count is unchanged), bounding
        # the live fragment count exactly as the host-side ``captureStray`` does
        # with its ``MAX_PENDING_CHUNKS``. The seal is INCREMENTAL: only the
        # current ``_pending`` fragments (≤ cap) are joined into one block, not
        # the whole accumulated buffer, so a large drip stays O(B) rather than
        # re-copying the growing block O(B²/cap) times.
        self._PENDING_MAX_CHUNKS = 1024

    def _pending_parts(self) -> list[str]:
        """The sealed blocks followed by the current fragments, for joining."""
        return [*self._pending_blocks, *self._pending]

    def writable(self) -> bool:  # noqa: D401 -- inherited contract
        return True

    def write(self, text: str) -> int:  # noqa: D401 -- inherited contract
        # Serialize the whole read-modify-write against the settlement flush and
        # any other thread's write: model code may spawn daemon threads that keep
        # printing after the program body returns, and this method reads
        # ``remaining`` and mutates ``_pending``/the ledger across many steps. The
        # lock is the buffer's and is re-entrant, so the ``push`` calls below
        # (which re-acquire it) do not deadlock.
        with self._logs.lock:
            return self._write_locked(text)

    def _write_locked(self, text: str) -> int:
        # Drop an empty write instead of buffering it. An empty chunk adds no
        # character, so the budget check below can never fire on it:
        # ``while True: sys.stdout.write("")`` would append one list slot per
        # call with `_pending_chars` pinned at 0, growing unbounded long after
        # the log ledger was exhausted (about 3.7 M slots per CPU second here)
        # until RLIMIT_AS turned the allocation into a MemoryError — reported as
        # the program's own exception rather than the intended bounded-log
        # behavior. Returning here also keeps `flush_line` from pushing a
        # spurious empty log entry for a program whose only writes were empty.
        if not text:
            return 0
        if "\n" in text:
            # Scan `text` in place; the buffered chunks are joined ONLY into the
            # first line. Joining the pending chunks with the whole write first
            # made a second copy of that write, which an over-budget write
            # cannot afford (measured under a 400 MiB addressSpaceMb: one
            # buffered character followed by a 340 MiB write died on MemoryError
            # inside the join, reported as the program's own exception, and the
            # retained chunks made the settlement `flush_line` fail the same way
            # — costing the `done` frame and turning the run into a wall-clock
            # timeout instead of the promised truncation marker).
            length = len(text)
            pos = 0
            if self._pending or self._pending_blocks:
                newline = text.index("\n")
                # The +3 cheap-bound overhead (quotes + separator) belongs to a
                # NEW entry. While an `open` entry is accumulating, the closing
                # line is that entry's TAIL: its cheap bound is the content
                # length alone, matching `_push_locked`'s open-aware bound.
                # This bound's observable behavior is invariant under the
                # overhead either way: when the +3 form trips and the open-aware
                # form does not (pending + newline in [remaining - 2, remaining]),
                # _push_bounded_prefix re-slices the SAME line text (the extra
                # slice `text[:newline]` carries no newline) and _push_locked
                # admits it under the same open-aware billing, byte for byte.
                # The open-aware form only keeps _push_bounded_prefix's "certain
                # to reject" precondition true, which is exactly what the scan
                # pre-check below does NOT preserve (its slice carries the
                # newline, so push genuinely rejects and truncates).
                overhead = 3 if not self._logs._open_started else 0
                if self._pending_chars + newline + overhead > self._logs.remaining:
                    # The reconstructed first line cannot fit the ledger, so
                    # LogBuffer would reject it whole: copy only the prefix that
                    # fails its cheap bound and drop the chunks. The slice is
                    # bounded HERE, not inside the helper: `text[:newline]` on a
                    # 340 MiB newline-terminated write is the same full copy the
                    # join was (measured: MemoryError inside `sys.stdout.write`
                    # under a 400 MiB addressSpaceMb), and `remaining + 4`
                    # characters are all the helper can use.
                    self._push_bounded_prefix(text[: min(newline, self._logs.remaining + 4)])
                else:
                    self._pending.append(text[:newline])
                    line = "".join(self._pending_parts())
                    self._pending = []
                    self._pending_blocks = []
                    self._pending_chars = 0
                    self._logs.push(line)
                pos = newline + 1
            # Scan by offset and STOP once the ledger is exhausted: a single
            # write of many newlines (``print("\n" * 1000000)``) would otherwise
            # re-slice the tail once per line and keep pushing long after
            # LogBuffer truncated, burning the CPU budget on discarded lines.
            # `remaining` reads 0 the instant the buffer truncates, so the loop
            # exits immediately; the unscanned tail is simply dropped.
            while pos < length and self._logs.remaining > 0:
                newline = text.find("\n", pos)
                if newline < 0:
                    break
                # Bound the SLICE the same way LogBuffer bounds the encode: a
                # first line far above the ledger would be copied whole before
                # push could reject it, and that copy is the allocation an
                # over-budget write cannot afford. Copy only a budget-sized
                # prefix, which push still rejects on its own cheap bound (the
                # prefix is longer than `remaining`), so the marker is emitted
                # and the oversized line is never materialized.
                overhead = 3 if not self._logs._open_started else 0
                if newline - pos + overhead > self._logs.remaining:
                    self._logs.push(text[pos:pos + self._logs.remaining + 4])
                    break
                self._logs.push(text[pos:newline])
                pos = newline + 1
            if pos < length:
                if self._logs.remaining > 0:
                    # Buffer only a budget-sized PREFIX of the tail, not the whole
                    # `text[pos:]`: an early newline followed by a huge unterminated
                    # tail (`"\n" + "A" * 30 MiB`) would otherwise copy the entire
                    # tail into `_pending` here — a second full copy of the model's
                    # own string, the RLIMIT_AS death this path exists to avoid —
                    # before the newline-free trigger below could bound it. Anything
                    # past `remaining` characters cannot be admitted (the char count
                    # is a lower bound on the serialized cost), so a
                    # `remaining + 4`-character prefix is all that can ever survive;
                    # the flush trigger below rejects it and emits the marker.
                    tail = text[pos:pos + self._logs.remaining + 4]
                    self._pending.append(tail)
                    self._pending_chars = len(tail)
                else:
                    # The ledger ran out with text still unscanned, so that text
                    # IS being dropped and the run must say so. One push is
                    # enough and is bounded: `remaining` is 0, so LogBuffer's
                    # cheap length lower bound rejects immediately, emits the
                    # marker, and never encodes the tail — and a push after the
                    # marker is already out returns without emitting a second.
                    # Reaching 0 EXACTLY (65 one-character lines against the
                    # default 3-byte-per-entry serialized charge) leaves
                    # `_truncated` unset, so without this the tail vanished with
                    # no marker at all. Sliced to a budget-sized prefix, not the
                    # whole tail: the tail can be hundreds of megabytes and the
                    # copy would be the RLIMIT_AS death this bound exists to
                    # avoid, while push only needs enough characters to fail its
                    # own cheap length check.
                    self._logs.push(text[pos:pos + self._logs.remaining + 4])
        else:
            self._pending.append(text)
            self._pending_chars += len(text)
            # Seal the fragment list past the chunk cap: a newline-free drip
            # appends one fragment per write, so a 25 M single-character flood
            # would accumulate that many list slots (and str objects) long before
            # the byte budget is met — the pointer array alone being ~25 M slots.
            # Past the cap the current fragments are joined into ONE block and
            # moved to `_pending_blocks` (character count unchanged), bounding the
            # live fragment count exactly as the host-side `captureStray` seal
            # does. The join is only the ≤cap current fragments, never the whole
            # accumulated buffer, so a large drip stays O(B) rather than
            # re-copying the growing block O(B²/cap) times; a newline never starts
            # a multi-byte sequence, so the fragments are un-sealable mid-line.
            if len(self._pending) >= self._PENDING_MAX_CHUNKS:
                self._pending_blocks.append("".join(self._pending))
                self._pending = []
        # A newline-free flood must hit the budget while running, not at
        # settlement: once the buffered tail alone can no longer fit the
        # ledger (chars lower-bound the serialized cost), push it through — LogBuffer
        # truncates, emits the marker once, and swallows everything after.
        if self._pending_chars > self._logs.remaining:
            self._push_bounded_prefix()
        return len(text)

    def _push_bounded_prefix(self, extra: str = "") -> None:
        # Reached only when the buffered characters already exceed what the
        # ledger admits, so LogBuffer is certain to reject on its cheap length
        # bound and emit the marker. Copy a budget-sized PREFIX rather than the
        # joined whole: ``sys.stdout.write("x")`` followed by one newline-free
        # 340 MiB write leaves two chunks whose join is a second copy of the
        # payload, and under a tight addressSpaceMb that join raises MemoryError
        # from inside `write` — surfacing as the program's own exception, or,
        # while the oversized chunks stayed retained, again from `flush_line`
        # after the program settled, which cost the `done` frame and turned the
        # run into a wall-clock timeout instead of the promised truncation
        # marker.
        #
        # The chunks are dropped BEFORE the push so neither this call nor the
        # settlement flush can repeat the allocation, and dropping the text is
        # exactly what the marker reports. `remaining + 4` is the shortest
        # prefix that still fails LogBuffer's ``len(text) + 3 > remaining``
        # check; the accumulation stops there, so the copy is bounded by the log
        # budget however large the pending chunks are.
        #
        # `self._pending` is iterated IN PLACE and `extra` handled after it:
        # `(*self._pending, extra)` would first copy every pending reference into
        # a same-size tuple, which for a single-character drip (millions of tiny
        # chunks) is a second pointer array as large as the list itself --
        # measured at +80 MiB of tuple on top of a 40 MiB list for 5.2M chunks,
        # the allocation this bounded prefix exists to avoid.
        limit = self._logs.remaining + 4
        parts: list[str] = []
        total = 0
        for chunk in self._pending_parts():
            parts.append(chunk[: limit - total])
            total += len(parts[-1])
            if total >= limit:
                break
        else:
            # Only reached when the pending chunks did not fill the prefix, so
            # `extra` is the one remaining source of text.
            parts.append(extra[: limit - total])
        self._pending = []
        self._pending_blocks = []
        self._pending_chars = 0
        self._logs.push("".join(parts))

    def flush(self) -> None:  # noqa: D401 -- inherited contract
        # ``TextIOBase.flush`` is a no-op, so without this override an explicit
        # ``print(..., flush=True)`` or ``sys.stdout.flush()`` left the text in
        # `_pending` with nothing to drain it except `flush_line` after the
        # program settles. A run that then hangs or is killed never reaches that
        # call: ``print("before hang", end="", flush=True)`` followed by an
        # infinite loop returned `logs: []`, losing the one diagnostic the
        # program deliberately committed. Forwarding makes an explicit flush emit
        # the pending entry immediately, which is what the caller asked for; a
        # newline-terminated write already emitted on its own.
        self.flush_line()

    def flush_line(self) -> None:
        """Push any buffered text not terminated by a newline (also serves explicit flushes)."""

        # Same shared, re-entrant lock as ``write``: the settlement flush on the
        # main coroutine and a daemon thread's concurrent ``write`` both touch
        # ``_pending`` and the ledger, so this read-and-clear must be atomic
        # against them.
        with self._logs.lock:
            if self._pending or self._pending_blocks:
                # Join, drop the chunks, THEN push — the same join-clear-push order
                # as `_write_locked`'s newline branch. Pushing before the clear would keep the
                # pending chunks alive through `_push_locked`'s `text.encode`, so
                # the chunks, their join, and the encode copy would all be live at
                # once; dropping the chunks first leaves only the join and its
                # encode, matching that path's peak.
                line = "".join(self._pending_parts())
                self._pending = []
                self._pending_blocks = []
                self._pending_chars = 0
                # The line has NO trailing newline: mark the frame `open` so the
                # host appends the next log frame to the same entry instead of
                # inserting a fake newline between two entries.
                self._logs.push(line, open=True)


# ---------------------------------------------------------------------------
# Fd-3 channel — line-framed JSON.
# ---------------------------------------------------------------------------


# Non-string scalars only. The string form is scanned by hand in
# :func:`_decode_json_plain` because a ``(?:[^"\\]|\\.)*`` repetition makes
# CPython's backtracking engine retain per-repetition state proportional to the
# string's WIDTH: measured at ~146 MiB of engine state for a 1 MiB string and
# ~558 MiB for 4 MiB, so a legitimate multi-megabyte binding reply raised
# MemoryError out of ``_pump_replies``, leaving its future unsettled until the
# wall clock reported a timeout.
_SCALAR_RE = re.compile(
    r'-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null'
)

# A run of ordinary string body characters. The star applies to a CHARACTER
# CLASS, which the engine matches in one linear pass with no backtracking state,
# so the scanner's cost is the number of escapes, not the string's width.
_STRING_CHUNK_RE = re.compile(r'[^"\\]*')


def _decode_json_plain(
    text: str,
    # Def-time captures: the decoder runs AFTER the program (which is `__main__`)
    # may have rebound `__main__.json`, `__main__._SCALAR_RE`,
    # `__main__._STRING_CHUNK_RE`, or `__main__.len`; a call-time lookup would
    # let a one-line rebind kill the reply pump (a broken decode strands every
    # pending Future to the wall clock). Defaults are evaluated at def time.
    _json_loads: Any = json.loads,
    _scalar_re: Any = _SCALAR_RE,
    _string_chunk_re: Any = _STRING_CHUNK_RE,
    _len: Any = len,
    _isinstance: Any = isinstance,
    _str: Any = str,
    _list: Any = list,
) -> Any:
    """Parse one JSON document iteratively (no per-level recursion).

    ``json.loads`` recurses per nesting level and raises ``RecursionError``
    around ~10k levels, but a binding reply is depth-unbounded by the seam
    contract — the host's iterative encoder happily produces documents
    ``json.loads`` cannot read back. Scalars (numbers, strings with escapes)
    are delegated to ``json.loads`` one token at a time, so their grammar and
    semantics stay CPython's own; only the container structure is parsed here
    with an explicit stack. Raises ``ValueError`` on malformed input; frames
    come from the TRUSTED host, so strictness mirrors ``json.loads`` without
    extra hostile-input hardening.
    """

    length = _len(text)

    def skip_ws(i: int) -> int:
        while i < length and text[i] in " \t\n\r":
            i += 1
        return i

    def scan_string(i: int) -> int:
        # Walk chunk by chunk: each match consumes every character up to the next
        # quote or backslash, so an escape costs one extra step and a plain body
        # costs one pass. Returns the offset just past the closing quote.
        j = i + 1
        while True:
            j = _string_chunk_re.match(text, j).end()
            if j >= length:
                raise ValueError(f"unterminated string at offset {i}")
            char = text[j]
            if char == '"':
                return j + 1
            # text[j] is a backslash: skip it and the character it escapes. A
            # trailing backslash runs j past `length`, caught on the next pass.
            j += 2

    def scalar(i: int):
        if i < length and text[i] == '"':
            end = scan_string(i)
            return _json_loads(text[i:end]), end
        match = _scalar_re.match(text, i)
        if match is None:
            raise ValueError(f"invalid JSON at offset {i}")
        return _json_loads(match.group(0)), match.end()

    def string_key(i: int):
        key, end = scalar(i)
        if not _isinstance(key, _str):
            raise ValueError(f"object key must be a string at offset {i}")
        end = skip_ws(end)
        if end >= length or text[end] != ":":
            raise ValueError(f"expected ':' at offset {end}")
        return key, skip_ws(end + 1)

    # Frames: a list, or (dict, pending key). `value`/`have_value` carry each
    # completed value up to its parent frame.
    stack: list[Any] = []
    value: Any = None
    have_value = False
    i = skip_ws(0)
    while True:
        if not have_value:
            ch = text[i] if i < length else ""
            if ch == "[":
                i = skip_ws(i + 1)
                if i < length and text[i] == "]":
                    i += 1
                    value, have_value = [], True
                else:
                    stack.append([])
                    continue
            elif ch == "{":
                i = skip_ws(i + 1)
                if i < length and text[i] == "}":
                    i += 1
                    value, have_value = {}, True
                else:
                    key, i = string_key(i)
                    stack.append(({}, key))
                    continue
            else:
                value, i = scalar(i)
                have_value = True
        if not stack:
            i = skip_ws(i)
            if i != length:
                raise ValueError(f"trailing data at offset {i}")
            return value
        top = stack[-1]
        i = skip_ws(i)
        ch = text[i] if i < length else ""
        if _isinstance(top, _list):
            top.append(value)
            if ch == ",":
                i = skip_ws(i + 1)
                have_value = False
            elif ch == "]":
                i += 1
                stack.pop()
                value = top
            else:
                raise ValueError(f"expected ',' or ']' at offset {i}")
        else:
            container, key = top
            container[key] = value
            if ch == ",":
                key, i = string_key(skip_ws(i + 1))
                stack[-1] = (container, key)
                have_value = False
            elif ch == "}":
                i += 1
                stack.pop()
                value = container
            else:
                raise ValueError(f"expected ',' or '}}' at offset {i}")


class ProtocolChannel:
    """Blocking readers and synchronous writers over the fd-3 protocol pipe.

    Writes are unbuffered and go straight to the fd, so ``send_sync`` is safe
    from inside model code (which may run outside an asyncio task) and from
    background tasks alike. Concurrent writers are serialized by ``_write_lock``
    around a full-write loop (see ``send_sync``): ``os.write`` releases the GIL,
    a frame may exceed ``PIPE_BUF`` (logs up to ``maxLogBytes``, completions up
    to ``maxValueBytes``, uncapped ``call`` args), and one ``os.write`` may
    consume only part of a frame — so neither the GIL nor per-frame atomicity is
    relied on for framing.
    """

    def __init__(self, fd: int) -> None:
        self._fd = fd
        # Residual bytes read past a frame's newline, shared by the blocking and
        # async readers. Held here, not in the reading coroutine: the reply pump
        # is cancelled once `done` is posted, and read-ahead sitting in a local
        # would be lost with it. Both readers use `os.read(self._fd, ...)`
        # directly, so no buffered file object wraps the fd.
        self._pending = bytearray()
        # Serializes writers: os.write releases the GIL, and a frame larger
        # than PIPE_BUF is neither atomic nor guaranteed fully consumed by one
        # call — without the lock, model-created threads printing while a big
        # completion frame drains could interleave bytes mid-frame.
        self._write_lock = threading.Lock()

    def read_frame(
        self,
        # Def-time captures for the decode primitives (see _decode_json_plain):
        # this runs before the program, but the reply path does not — a rebind
        # of `__main__._decode_json_plain`/`__main__.os`/`__main__._READ_CHUNK_BYTES`
        # must not break the pump.
        _decode: Any = _decode_json_plain,
        _os_read: Any = os.read,
        _read_chunk: int = _READ_CHUNK_BYTES,
        _bytes: Any = bytes,
        _len: Any = len,
    ) -> dict[str, Any] | None:
        """Read one JSON-line frame (iteratively decoded). ``None`` on EOF.

        Blocking. Used for the two frames read BEFORE the model program starts
        (``boot`` and ``run``), where blocking is what the handshake wants. Reply
        frames arriving during the program go through :meth:`read_frame_async`,
        which must not occupy a thread.

        Reads in CHUNKS into the shared ``_pending`` buffer rather than through
        ``FileIO.readline()``: the fd is unbuffered (``buffering=0``), so
        ``readline`` issues one ``os.read(1)`` per byte, and a multi-megabyte
        ``run`` frame — RLIMIT_CPU already in force by then — would burn the
        budget in millions of syscalls before ``ast.parse`` even runs. The chunk
        reads and the same residual buffer the async path uses keep read-ahead
        past a newline for the next frame.
        """

        # Scan only the bytes not yet examined: `find` from a running offset so a
        # frame arriving in N chunks costs one linear pass total, not one rescan
        # of the whole buffer per chunk (which is quadratic in the frame size).
        scanned = 0
        while True:
            newline = self._pending.find(b"\n", scanned)
            if newline >= 0:
                line = _bytes(self._pending[:newline])
                del self._pending[: newline + 1]
                return _decode(line.decode("utf-8"))
            scanned = _len(self._pending)
            chunk = _os_read(self._fd, _read_chunk)
            if not chunk:
                # EOF before a newline: drop the partial line, as the host drops
                # a frame that never completed.
                return None
            self._pending.extend(chunk)

    async def read_frame_async(
        self,
        # Def-time captures, same rationale as read_frame.
        _decode: Any = _decode_json_plain,
        _os_read: Any = os.read,
        _read_chunk: int = _READ_CHUNK_BYTES,
        _bytes: Any = bytes,
        _get_event_loop: Any = asyncio.get_event_loop,
        _len: Any = len,
    ) -> dict[str, Any] | None:
        """Await one JSON-line frame without occupying a thread. ``None`` on EOF.

        ``loop.run_in_executor(None, read_frame)`` was the obvious spelling and
        the wrong one: the default executor spins up its first thread the moment
        the program awaits a binding, and on Linux/glibc that thread's 8 MiB
        stack plus a 64 MiB per-thread malloc arena reservation are charged to
        ``RLIMIT_AS`` — measured, the child's mappings went from 30.34 MiB to
        102.39 MiB across one ``await tools.*``. Since the limit is already in
        force, that ~72 MiB comes straight out of the run's ``addressSpaceMb``:
        under a small limit the thread cannot start at all and a legitimate
        binding call hangs to ``maxWallMs``, and under a larger one an allocation
        that should have fit dies as ``MemoryError``. This is the same accounting
        the settlement-time CPU recheck was designed around, where a sampling
        thread cost the same 72 MiB.
        `loop.add_reader` watches the fd instead, so no thread exists.

        Bytes past a frame's newline belong to the next frame, so the residual
        lives on the CHANNEL rather than in this coroutine: the pump is cancelled
        once ``done`` is posted, and a local buffer would discard whatever it had
        read ahead.
        """

        loop = _get_event_loop()
        # Scan only the not-yet-examined bytes (running offset), so a frame
        # arriving across many reads costs one linear pass, not a quadratic
        # rescan of the whole buffer per read.
        scanned = 0
        while True:
            newline = self._pending.find(b"\n", scanned)
            if newline >= 0:
                line = _bytes(self._pending[:newline])
                del self._pending[: newline + 1]
                return _decode(line.decode("utf-8"))
            scanned = _len(self._pending)
            ready = loop.create_future()
            # `add_reader` only reports readability; the read itself happens here,
            # and `os.read` returns whatever is buffered without waiting for more.
            loop.add_reader(self._fd, lambda: ready.done() or ready.set_result(None))
            try:
                await ready
            finally:
                loop.remove_reader(self._fd)
            chunk = _os_read(self._fd, _read_chunk)
            if not chunk:
                # EOF. Any partial line is dropped, matching how the host drops a
                # frame that never completed.
                return None
            self._pending.extend(chunk)

    def send_sync(self, message: dict[str, Any]) -> None:
        """Post one frame synchronously.

        Encoded with the iterative :func:`_encode_json_plain` (not
        ``json.dumps``, whose per-level recursion would raise
        ``RecursionError`` on a deeply nested completion or call argument the
        depth-unbounded ``CodeJsonValue`` contract admits). NaN/Infinity still
        raise ``ValueError`` — they would serialize as non-standard tokens
        that Node's ``JSON.parse`` rejects, silently dropping the frame, and a
        call would then hang until the wall clock instead of failing fast.
        Callers turn the ``ValueError`` into their own contract error
        (dispatch raises the lossless-JSON message).
        """

        self.write_encoded(_encode_json_plain(message))

    def write_encoded(self, frame: str) -> None:
        """Write a frame that is ALREADY encoded to its JSON string form.

        Appends the frame's trailing newline and full-write-loops the bytes
        under the writer lock, identically to :meth:`send_sync`. The consumer
        supplies the encoded JSON (a ``"done"`` frame carrying a completion
        value that was serialized at its validation point — see
        :func:`_done_with_value`); the channel does not re-encode it, so the
        bytes written are exactly what was validated with no second traversal
        of a live object.
        """

        payload = (frame + "\n").encode("utf-8")
        # Full-write loop under the writer lock (same rationale as send_sync):
        # one os.write may consume only part of a frame beyond PIPE_BUF, and a
        # partial or interleaved frame is dropped host-side as malformed JSON.
        with self._write_lock:
            view = memoryview(payload)
            while view:
                view = view[os.write(self._fd, view):]


# ---------------------------------------------------------------------------
# Tools proxy — turns ``await tools.name(args)`` into a fd-3 call frame.
# ---------------------------------------------------------------------------


class _Namespace:
    """A proxy for one binding namespace: every declared name routes to the bridge.

    Names arrive from :class:`BootMessage.namespaces`. Both attribute access
    (``tools.name``) and subscript access (``tools["my-tool"]`` — the SDK's
    escape hatch for exotic or reserved names, which are legal function names
    on the wire) return a coroutine factory that posts a ``call`` frame and
    awaits the matching ``reply``. An undeclared name raises ``AttributeError``
    (attribute) or ``KeyError`` (subscript), matching the worker backend's
    own-property discipline.

    ``__getattribute__`` (not ``__getattr__``) intercepts attribute access so a
    declared name ALWAYS reaches the bridge — even one that collides with an
    inherited attribute like ``__class__``, which ordinary lookup would resolve
    on ``object`` before ``__getattr__`` ever ran. Internal state lives under
    name-mangled ``_Namespace__*`` attributes; a declared binding with such a
    name still wins (declared-names check runs first).
    """

    def __init__(self, global_name: str, names: list[str], dispatch) -> None:
        self.__global = global_name
        self.__names = set(names)
        self.__dispatch = dispatch

    def __call_for(self, name: str):
        dispatch = object.__getattribute__(self, "_Namespace__dispatch")
        global_name = object.__getattribute__(self, "_Namespace__global")

        async def call(args: Any) -> Any:
            return await dispatch(global_name, name, args)

        return call

    def __getattribute__(self, name: str):
        # Declared names route to the bridge unconditionally — before Python
        # can resolve an inherited attribute (``__class__``) or our own
        # internals. Everything else falls through to normal lookup so the
        # proxy machinery itself keeps working.
        names = object.__getattribute__(self, "_Namespace__names")
        if name in names:
            return object.__getattribute__(self, "_Namespace__call_for")(name)
        return object.__getattribute__(self, name)

    def __getattr__(self, name: str):
        # Reached only when normal lookup found nothing (declared names were
        # already intercepted above), so this is always an undeclared tool.
        raise AttributeError(
            f"tool {name!r} is not declared in namespace "
            f"{object.__getattribute__(self, '_Namespace__global')!r}"
        )

    def __getitem__(self, name: str):
        names = object.__getattribute__(self, "_Namespace__names")
        if name not in names:
            raise KeyError(
                f"tool {name!r} is not declared in namespace "
                f"{object.__getattribute__(self, '_Namespace__global')!r}"
            )
        return object.__getattribute__(self, "_Namespace__call_for")(name)


class _BindingRejection(Exception):
    """Internal reply-pump rejection, converted by ``dispatch`` into the
    namespace's declared error class (or ``RuntimeError``) so the marker type
    itself never reaches model code."""


def _make_error_class(
    name: str,
    member_name_property: str,
    # Def-time captures (see the __init__ body): the minted class runs AFTER
    # the program, so `__main__.Exception`/`__main__.setattr` rebinds must not
    # break the rejection constructor.
    _Exception_init: Any = Exception,
    _setattr: Any = setattr,
) -> type:
    """Mint one program-visible rejection class per the seam's
    ``CodeBindingErrorClass`` contract: instances carry the failed member name
    under ``member_name_property`` and render as their message."""

    def __init__(self, member_name: str, message: str) -> None:  # noqa: N807
        # Exception.__init__ and setattr are captured as defaults at def time:
        # the class constructor runs model-visible code paths, and a rebind of
        # `__main__.Exception`/`__main__.setattr` must not break a rejection.
        _Exception_init.__init__(self, message)
        _setattr(self, member_name_property, member_name)

    return type(name, (Exception,), {"__init__": __init__})


def _clamped(which: int, soft: int, hard: int) -> tuple[int, int]:
    """Bound a requested (soft, hard) rlimit pair by BOTH inherited limits.

    An unprivileged process may lower a hard limit but never raise it, so a
    harness already started under a tighter ceiling (``ulimit -v`` below
    ``addressSpaceBytes``, or a CPU cap below ``cpuSeconds`` + 1) would make
    ``setrlimit`` raise ``ValueError`` and fail every run — despite the
    inherited limit being STRONGER than the one requested. Clamping keeps the
    stricter of the two, which still satisfies the containment contract.

    Both inherited bounds matter, not just the hard one. A deployment that
    inherited a soft limit BELOW what is requested (e.g. inherited ``(100, 200)``,
    requested ``(150, 160)``) must keep the stricter soft — returning the
    requested ``150`` would RAISE the effective soft limit, loosening RLIMIT_AS
    memory or deferring the RLIMIT_CPU SIGXCPU, the opposite of "strictest of
    configured and inherited". So each side is clamped against its inherited
    counterpart. ``RLIM_INFINITY`` compares as -1, so an infinite inherited bound
    imposes no ceiling and the requested value stands.
    """
    inherited_soft, inherited_hard = resource.getrlimit(which)
    clamped_soft = soft if inherited_soft == resource.RLIM_INFINITY else min(soft, inherited_soft)
    clamped_hard = hard if inherited_hard == resource.RLIM_INFINITY else min(hard, inherited_hard)
    # setrlimit requires soft <= hard. Clamping the two sides independently can
    # invert them (a finite inherited soft below the clamped hard is fine, but a
    # requested hard below the inherited soft would leave soft > hard), so pin
    # soft under hard as the final step; the stricter hard ceiling wins.
    result_soft = min(clamped_soft, clamped_hard)
    result_hard = clamped_hard
    # For RLIMIT_CPU, a soft limit EQUAL to the hard limit leaves the kernel no
    # window to send SIGXCPU: it checks the hard limit in the same tick and
    # SIGKILLs directly (a `ulimit -t N` sets both, and a busy loop then dies by
    # SIGKILL, not SIGXCPU). The host classifies a CPU overrun ONLY on ``signal
    # === 'SIGXCPU'``, so a definite budget exhaustion would be misreported as a
    # `worker-exit`. Lowering the soft limit one unit below the hard (when the
    # hard is at least 2, so soft stays positive) keeps the stricter-of-the-two
    # containment semantics while giving SIGXCPU a window to fire — the CPU
    # overrun is then reported as a timeout, not a worker-exit. This is scoped to
    # RLIMIT_CPU: for RLIMIT_AS a one-byte soft differential would only misalign
    # the child's applied limit with the host-side budget gate, with no signal to
    # preserve. The ``hard >= 2`` guard leaves the ``hard == 1`` blind spot
    # (a 1-second dual limit cannot lower soft to 0) — a definite CPU overrun
    # there is still reported as `worker-exit`; see the settlement note.
    if (
        which == resource.RLIMIT_CPU
        and result_soft == result_hard
        and result_hard >= 2
    ):
        result_soft = result_hard - 1
    return (result_soft, result_hard)


# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------


async def _run(channel: ProtocolChannel) -> None:
    # The exception class every `except` clause in this function catches is bound
    # into a LOCAL at the very top, before any model code runs. This bootstrap IS
    # `__main__`, so `__main__.BaseException = RuntimeError` would otherwise
    # rebind the module global the `except BaseException` clauses resolve at
    # runtime — and a program exception that no longer matches would escape `_run`
    # with no done frame, misreporting the run as a `worker-exit`. A frame local
    # is not reachable by `__main__._X = ...`, so the catch is immune.
    _BaseException = BaseException
    # The child inherits the host's SIGXCPU disposition and signal mask. If
    # the host ignores or blocks SIGXCPU, the soft RLIMIT_CPU fires but cannot
    # stop the child — the hard limit's SIGKILL then classifies a definite CPU
    # overrun as substrate death (worker-exit) instead of a timeout. Reset to
    # the default disposition and unblock HERE, before the resource-limit setup
    # and the boot-namespace construction (which can burn CPU): a huge
    # namespace under an inherited ignore would otherwise reach the hard limit
    # inside that window. The settle-time enforcer already restores SIG_DFL for
    # a program that traps or masks the signal mid-run; this closes the
    # inherited-state gap.
    signal.signal(signal.SIGXCPU, signal.SIG_DFL)
    if getattr(signal, "pthread_sigmask", None) is not None:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, (signal.SIGXCPU,))
    # `RuntimeError` and the `_BindingRejection` marker class are likewise bound
    # into locals: `dispatch`'s `call_failure` and its `except` clause resolve
    # them at call time, and the program (running as `__main__`) can rebind the
    # module globals — `__main__._BindingRejection = ValueError` would leak the
    # marker type into model code, violating the class's conversion contract.
    # The names differ from the module globals (`_RuntimeError_cls`) so the
    # assignment RHS resolves the module global, not an unbound local.
    _RuntimeError_cls = RuntimeError
    _BindingRejection_cls = _BindingRejection
    # `str` for dispatch's rejection conversion is likewise bound: a program
    # rebinding `__main__.str` would otherwise run a hostile callable when the
    # binding-rejection message is formatted. `isinstance` for `send_done`'s
    # frame-shape check is bound the same way.
    _str = str
    _isinstance = isinstance
    # dispatch's argument-validation, event-loop, and frame-send primitives are
    # bound here, before the program runs: a rebind of `__main__._lossless_json_violation`,
    # `__main__.asyncio`, or the channel's send method must not turn a legitimate
    # binding call into an exception or a wall-clock timeout.
    _lossless_json_violation_cls = _lossless_json_violation
    _get_event_loop_cls = asyncio.get_event_loop
    _send_sync_cls = channel.send_sync
    # The frame WRITE primitives are bound too: send_sync's body resolves
    # `_encode_json_plain` (module global) and `self.write_encoded` (class
    # attribute) at call time, so a program rebinding either before the first
    # binding call could turn a legitimate call into an exception. dispatch
    # and the log sink both write through these directly (the sink does NOT go
    # through send_sync, whose body resolves the same names at call time).
    _write_encoded_cls = channel.write_encoded
    _encode_plain_cls = _encode_json_plain
    # 1. Boot handshake.
    boot = channel.read_frame()
    if boot is None or boot.get("type") != "boot":
        raise RuntimeError("bootstrap: expected boot frame on fd 3")

    # A limit that cannot be applied must fail the run as a diagnosable done
    # frame, not a bare traceback + exit(1): running the program UNCAPPED would
    # silently void the containment contract, and the host can only relay what
    # rides the protocol.
    try:
        # SIGXCPU's default disposition (how the soft CPU limit stops the child)
        # dumps core, and the child inherits the host's RLIMIT_CORE — a CPU
        # timeout would otherwise write a large memory-bearing core file into
        # the workspace. Forbid core dumps first so the timeout path leaves none.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # Soft limit at cpuSeconds fires SIGXCPU (its default disposition
        # terminates the child; the host classifies that close as a timeout).
        # Hard limit at +1s is a SIGKILL backstop for a program that traps
        # SIGXCPU and keeps burning CPU.
        cpu_soft, cpu_hard = _clamped(
            resource.RLIMIT_CPU, boot["cpuSeconds"], boot["cpuSeconds"] + 1
        )
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_soft, cpu_hard))
        # Darwin maps the multi-GB dyld shared cache into every process at
        # exec, so any practical RLIMIT_AS cap sits below current usage and
        # the kernel rejects it — the child would die here on every run. Skip
        # the address-space cap there; RLIMIT_CPU and the host's wall-clock
        # ceiling still bound the run.
        if sys.platform != "darwin":
            addr_bytes = int(boot["addressSpaceBytes"])
            effective_as = _clamped(resource.RLIMIT_AS, addr_bytes, addr_bytes)
            resource.setrlimit(resource.RLIMIT_AS, effective_as)
            # The host rejected an output budget too large for the CONFIGURED
            # addressSpaceMb, but a launch environment can inherit a STRICTER
            # RLIMIT_AS (e.g. a `ulimit -v` wrapper below addressSpaceMb), which
            # `_clamped` correctly lowers the effective limit to — leaving the
            # budgets validated against a ceiling the child never gets. Re-check
            # both budgets against the EFFECTIVE soft limit here, mirroring the
            # host gate (each budget times the worst-case Unicode multiple must
            # fit the room left after the interpreter baseline), and fail loud at
            # boot rather than letting a near-budget output OOM mid-run. The
            # constants match src/index.ts's OUTPUT_BUDGET_WORST_CASE_ADDRESS_
            # SPACE_MULTIPLE and INTERPRETER_BASELINE_BYTES.
            # `effective_soft` is always finite, so the re-check is
            # unconditional: `_clamped` was asked for the finite `addr_bytes` on
            # both sides, and each of its branches returns either that value or a
            # `min` with an inherited bound -- RLIM_INFINITY is not reachable. A
            # guard here would have silently skipped the whole re-check on the
            # branch it claimed to protect.
            effective_soft = effective_as[0]
            budgetable = effective_soft - _INTERPRETER_BASELINE_BYTES
            for _budget_key in ("maxLogBytes", "maxValueBytes"):
                if int(boot[_budget_key]) * _OUTPUT_BUDGET_WORST_CASE_MULTIPLE >= budgetable:
                    raise ValueError(
                        "config.%s is too large for the inherited RLIMIT_AS of %d bytes "
                        "(a near-budget output would breach it during encode); "
                        "lower the budget or raise the inherited address-space limit"
                        % (_budget_key, effective_soft)
                    )
    except _BaseException as exc:  # noqa: BLE001 -- report every failure to host; `_BaseException` is a pre-program local
        channel.send_sync(
            {
                "type": "done",
                "error": {
                    "kind": "exception",
                    # Exception-only rendering: format_exc() would embed the
                    # absolute installed bootstrap.py path in model-visible
                    # durable output, leaking host paths into transcripts.
                    "message": "bootstrap: applying resource limits failed\n"
                    + "".join(
                        traceback.format_exception_only(type(exc), exc)
                    ),
                },
            }
        )
        return

    logs = LogBuffer(
        int(boot["maxLogBytes"]),
        # The sink writes through the def-time bound encode+write primitives
        # (not _send_sync_cls, whose body still resolves _encode_json_plain and
        # self.write_encoded at call time) so a rebind cannot break a log frame.
        sink=lambda text, truncated=False, open=False: _write_encoded_cls(
            _encode_plain_cls(
                {
                    "type": "log",
                    "text": text,
                    **({"truncated": True} if truncated else {}),
                    **({"open": True} if open else {}),
                }
            )
        ),
    )

    # 2. Wire the tools proxies and the ack.
    #
    # Each entry records the reply Future AND the loop it was created on. Model
    # code may call a binding from a THREAD it started, spelled
    # ``asyncio.run(tools.x(...))`` or its own new loop in that thread, so a
    # Future here can belong to a loop other than the one ``_pump_replies`` runs
    # on. ``asyncio.Future`` is not thread-safe: completing it from another
    # thread does not wake its own loop, so the pump schedules the completion on
    # the owning loop via ``call_soon_threadsafe`` (see ``_pump_replies``) rather
    # than calling ``set_result`` directly.
    pending: dict[int, tuple[asyncio.AbstractEventLoop, asyncio.Future[Any]]] = {}
    next_id = 0
    # Serializes the id claim + write + counter advance in ``dispatch`` against
    # both other binding-calling threads and the pump's ``pop``. ``dispatch`` may
    # run concurrently on several loops/threads, and the host answers a ``call``
    # only when its id is the exact successor of the last one — so ids must reach
    # the wire in the order they are claimed. Holding this lock across the write
    # (not just the counter arithmetic) is what keeps two threads' frames from
    # interleaving on fd 3 out of id order, which the host would reject.
    pending_lock = threading.Lock()

    error_classes: dict[str, type] = {}

    async def dispatch(global_name: str, name: str, args: Any) -> Any:
        nonlocal next_id
        error_class = error_classes.get(global_name)

        def call_failure(message: str) -> BaseException:
            # The namespace's declared rejection contract (e.g. PTC mode's
            # ToolCallError with .toolName) when present; RuntimeError keeps
            # the pre-errorClass behavior for namespaces that declared none.
            if error_class is not None:
                return error_class(name, message)
            return _RuntimeError_cls(message)

        # Validate the argument shape before claiming an id, so a rejected call
        # leaves no gap in the sequence the host checks. json.dumps would coerce
        # a non-string dict key or non-finite float rather than raise (allow_nan
        # is off, but key coercion still slips through), silently corrupting what
        # the tool receives. Reject up front through the call's error contract.
        violation = _lossless_json_violation_cls(args)
        if violation is not None:
            raise call_failure(f"binding arguments must be lossless JSON ({violation})")
        # Ids are consecutive from 0 with NO gaps: the host answers a `call` only
        # when its id is the exact successor of the last one, which bounds the
        # state it retains to a single number. A frame that never reaches the
        # host must therefore not consume an id, so the counter advances only
        # once the write has succeeded.
        #
        # The whole claim-write-advance runs under ``pending_lock`` because a
        # binding may be called from more than one thread/loop at once (the model
        # can start a thread that runs ``asyncio.run(tools.x(...))``). Without
        # the lock two callers could claim the same id, or write their frames to
        # fd 3 in an order that does not match their ids — either of which the
        # host rejects as an out-of-sequence call. The Future's own loop is
        # captured here so ``_pump_replies`` can complete it thread-safely.
        loop = _get_event_loop_cls()
        with pending_lock:
            call_id = next_id
            fut: asyncio.Future[Any] = loop.create_future()
            pending[call_id] = (loop, fut)
            try:
                _write_encoded_cls(
                    _encode_plain_cls(
                        {
                            "type": "call",
                            "id": call_id,
                            "global": global_name,
                            "name": name,
                            "args": args,
                        }
                    )
                )
            except (TypeError, ValueError) as exc:
                pending.pop(call_id, None)
                raise call_failure(
                    f"binding arguments must be lossless JSON: {exc}"
                ) from exc
            next_id += 1
        try:
            return await fut
        except _BindingRejection_cls as exc:
            raise call_failure(_str(exc)) from None

    namespaces: dict[str, Any] = {}
    for entry in boot["namespaces"]:
        namespaces[entry["global"]] = _Namespace(
            entry["global"], entry["names"], dispatch
        )
        declared = entry.get("errorClass")
        if declared:
            error_class = _make_error_class(
                declared["name"], declared["memberNameProperty"]
            )
            error_classes[entry["global"]] = error_class
            # The class is program-visible under its own name so model code
            # can `except ToolCallError as e:` and read the member property.
            namespaces[declared["name"]] = error_class

    channel.send_sync({"type": "boot-ack"})

    # 3. Start a reply-pump task before the run message: replies can arrive
    # interleaved with the run's own binding traffic.
    # The pump's frame reader is bound here, before the program runs: the
    # pump itself starts AFTER the program's top-level statements (no suspension
    # point between create_task and `await __dsh_main__`), so a body-local
    # `channel.read_frame_async` lookup would resolve a rebound class method.
    pump_read = channel.read_frame_async
    reply_task = asyncio.get_event_loop().create_task(
        _pump_replies(channel, pending, pending_lock, pump_read)
    )

    # 4. Read the run message.
    run = channel.read_frame()
    if run is None or run.get("type") != "run":
        reply_task.cancel()
        raise RuntimeError("bootstrap: expected run frame on fd 3")

    program: str = run["program"]

    # 5. Install log capture — ``print``, tracebacks, and ordinary ``sys.stdout``
    # writes funnel into the LogBuffer. The real fds stay open (host uses
    # stderr for stray-byte accounting) but the Python-visible streams point
    # at the buffer.
    sys.stdout = _LogStream(logs)  # type: ignore[assignment]
    sys.stderr = _LogStream(logs)  # type: ignore[assignment]
    out_stream, err_stream = sys.stdout, sys.stderr
    # The ORIGINAL std streams are bound here, before the program runs, so the
    # settlement flush can drain bytes a program wrote through them without an
    # explicit flush. The bootstrap only replaces `sys.stdout`/`sys.stderr` with
    # the `_LogStream`; `sys.__stdout__`/`sys.__stderr__` (and C-ext stdio
    # layered on the same fds) are untouched, and their block-buffered bytes are
    # lost when the host SIGTERMs the child right after the done frame — the
    # default SIGTERM disposition terminates without interpreter finalization.
    # Binding the names here (before the program) makes them immune to a
    # `sys.__stdout__ = boom` rebind in model code; `None` under `-S`-style
    # redirects is guarded at flush time.
    # Bind the FLUSH METHODS, not the stream objects: the settlement flush
    # loop iterates callables, and a bare TextIOWrapper object is not callable —
    # invoking it would raise TypeError and be swallowed by the loop's except,
    # silently disabling the drain. A bound method captures its stream at
    # binding time, so a later `sys.__stdout__ = boom` rebind cannot redirect
    # it; `None` (stream absent) is guarded at flush time.
    _stdout_orig = sys.__stdout__.flush if sys.__stdout__ is not None else None
    _stderr_orig = sys.__stderr__.flush if sys.__stderr__ is not None else None

    # 6. Compile the program as the body of an async function, matching the
    # seam contract (`CodeRunRequest.program` is an async-function body: top-level
    # `await` and `return` both work, and the returned value is the completion).
    # AST-splicing the parsed body into an `async def` keeps every statement's
    # original line number, so a traceback points at the model's own source.
    ns: dict[str, Any] = {
        "__name__": "__main__",
        "__builtins__": __builtins__,
        **namespaces,
    }
    # Read the enforcement callable and its budget into this frame's locals
    # BEFORE the program runs: model code can rebind this module's globals
    # (the bootstrap IS ``__main__``), and a frame local is not a module
    # attribute, so a later ``__main__._DIE_IF_CPU_EXHAUSTED = ...`` cannot
    # change which callable the post-check below invokes. This defeats the
    # one-line rebind, not a determined `sys._getframe` walk; the unforgeable
    # bounds are the RLIMIT_CPU hard limit and the host wall clock
    # (see _make_cpu_enforcer).
    die_if_cpu_exhausted = _DIE_IF_CPU_EXHAUSTED
    # The settlement recheck compares against the EFFECTIVE soft CPU limit
    # (`cpu_soft`, clamped to any stricter inherited limit above), NOT the
    # configured `cpuSeconds`. When the deployment inherited a soft limit below
    # the configured value, a program that traps SIGXCPU, burns past the
    # inherited soft, and returns inside the soft-to-hard gap must be reported as
    # a timeout — checking the configured value would falsely pass it and bypass
    # the inherited limit.
    cpu_seconds = cpu_soft
    # Same capture, same reason, for the failure path and the send that follows
    # it. The reporter was a module-global lookup inside the `except` block, so
    # ``import __main__; __main__._SAFE_MODEL_TRACEBACK = ...`` put model code
    # there with no guard around it; the flush and send were attribute lookups
    # on the stream and channel CLASSES, which ``__main__._LogStream.flush_line
    # = ...`` rebinds just as easily. All four run AFTER the handler, where a
    # throw costs the `done` frame and the host reports a wall-clock timeout
    # instead of the model's exception. Binding the callables now fixes what
    # runs; what they in turn reach is closed over in _make_failure_reporter.
    safe_model_traceback = _SAFE_MODEL_TRACEBACK
    flush_out = out_stream.flush_line
    flush_err = err_stream.flush_line
    # `done` is either a pre-encoded frame STRING (a `_done_with_value` success:
    # the completion value was serialized at its validation point, inside the try,
    # so a later send never re-walks the live value a mutating daemon thread could
    # have changed) or a dict ERROR frame (a rejection or the exception handler,
    # which carry no live model value). `send_done` posts whichever form, going
    # DIRECTLY through a bound `_encode_json_plain` and a bound `write_encoded` —
    # never through `channel.send_sync`, whose body re-resolves `self.write_encoded`
    # and `self`'s module-level `_encode_json_plain` at call time.
    #
    # The program runs as `__main__`, so `import __main__; __main__.ProtocolChannel
    # .send_sync = boom` or `__main__._encode_json_plain = boom` would otherwise
    # re-resolve the send/encode to a rebranded callable at call time and, when
    # that replacement raises, skip the `done` frame and downgrade a settled
    # verdict to a host-side worker-exit (the binding-all-names regression test
    # pins this). Same reason `flush_out`/`flush_err`/`safe_model_traceback` are
    # bound above.
    encode_plain_bound = _encode_json_plain
    write_encoded_bound = channel.write_encoded
    # The completion-frame builder is bound into a LOCAL here, before the
    # program runs: `done = _done_with_value(...)` below sits after the program
    # (which is `__main__`) may have rebound `__main__._done_with_value`, so a
    # module-global lookup at call time would let a one-line rebind rewrite a
    # legitimate success into an `exception`. Binding it (with its own def-time
    # default-captured `_check_done_value`/`_encode_json_plain`) makes the entry
    # name immune.
    done_with_value_bound = _done_with_value
    # The fallback primitives are bound into LOCALS here, before the program
    # runs, so `send_done`'s except arm does not read module globals at call
    # time. This bootstrap is `__main__`, so `__main__._os_write = boom` (or
    # `__main__._FALLBACK_DONE_FRAME`, `__main__._memoryview`) would otherwise
    # rebind exactly the names the fallback reads, reopening the single-line-
    # rebind hole the fallback exists to close.
    _os_write_local = _os_write
    _memoryview_local = _memoryview
    _fallback_frame_local = _FALLBACK_DONE_FRAME

    def send_done(payload: dict[str, Any] | str) -> None:
        try:
            if _isinstance(payload, _str):
                write_encoded_bound(payload)
            else:
                write_encoded_bound(encode_plain_bound(payload))
        except:  # noqa: BLE001, E722 -- a rebind must not cost the done frame; bare except avoids naming BaseException
            # `encode_plain_bound`/`write_encoded_bound` are bound callables, but
            # their BODIES still resolve transitive module globals at call time —
            # `_encode_json_plain` reaches `_dump_scalar`/`_dump_string`/`json.dumps`,
            # `write_encoded` reaches `os.write` (via the `os` module). This
            # bootstrap is `__main__`, so `__main__._dump_scalar = boom` (or
            # `__main__.os = ...`) makes the error-frame encode/write throw AFTER
            # the `except` block, which would drop the `done` frame and downgrade a
            # settled `exception` verdict to a host-side `worker-exit`. Write a fixed
            # literal done frame with the LOCALLY-BOUND `_os_write_local` and
            # `_memoryview_local` (captured before the program runs, so a one-line
            # rebind of the module global cannot change them) so the host still gets
            # a verdict. The literal is JSON-valid and newline-terminated; the lock
            # is the channel's, so the write is serialized against any concurrent
            # writer.
            with channel._write_lock:
                view = _memoryview_local(_fallback_frame_local)
                while view:
                    view = view[_os_write_local(channel._fd, view):]

    max_value_bytes = int(boot["maxValueBytes"])
    done: dict[str, Any] | str
    try:
        # filename="<model>" keeps the source label consistent with the later
        # compile(wrapped, "<model>", ...) and the runtime traceback filtering
        # (safe_model_traceback drops frames whose filename is not "<model>");
        # the default "<unknown>" would leak a different label into model-visible
        # syntax diagnostics.
        module = ast.parse(program, filename="<model>")
        wrapper = ast.AsyncFunctionDef(
            name="__dsh_main__",
            args=ast.arguments(
                posonlyargs=[], args=[], vararg=None,
                kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[],
            ),
            body=module.body or [ast.Pass()],
            decorator_list=[],
            returns=None,
        )
        # Anchor the synthetic wrapper on the first real statement (or line 1 for
        # an empty program) so fix_missing_locations does not stamp it at 0.
        anchor = module.body[0] if module.body else ast.parse("pass").body[0]
        ast.copy_location(wrapper, anchor)
        wrapped = ast.Module(body=[wrapper], type_ignores=[])
        ast.fix_missing_locations(wrapped)
        # `dont_inherit=True` stops this module's `from __future__ import
        # annotations` (line 14) from leaking into the program's compile: PEP 563
        # would otherwise stringify the program's type annotations, changing the
        # semantics of a legal program that reads `f.__annotations__` at runtime.
        code = compile(wrapped, "<model>", "exec", dont_inherit=True)
        exec(code, ns)  # noqa: S102 -- defines __dsh_main__; executing model code is the point
        value = await ns["__dsh_main__"]()
        die_if_cpu_exhausted(cpu_seconds)
        # Flush the log buffers BEFORE metering and framing the completion value.
        # `_done_with_value` materializes the value's escaped JSON form to meter
        # it and then pre-encodes the admitted value into its frame (see its
        # docstring for the TOCTOU rationale) — several copies of a near-budget
        # value live at once (see OUTPUT_BUDGET_WORST_CASE_ADDRESS_SPACE_MULTIPLE).
        # Any unflushed log pending would add its own bytes to that peak, so a
        # `maxLogBytes` and a `maxValueBytes` each admitted alone by the load gate
        # could together breach RLIMIT_AS. Flushing first frees the log pending so
        # the value frame's peak stands alone against the address space.
        flush_out()
        flush_err()
        done = done_with_value_bound(value, max_value_bytes)
    except _BaseException as exc:  # noqa: BLE001 -- report every failure to host; `_BaseException` is a pre-program local, not a rebindable module global
        done = {
            "type": "done",
            "error": {
                "kind": "exception",
                # Cap the diagnostic BEFORE it crosses the wire: a program can
                # raise with a gigabytes-long message, and formatting/sending
                # it whole would allocate on both sides before the host's own
                # cap runs. Byte-cap at maxValueBytes with the host's marker
                # text so the truncated diagnostic reads identically wherever
                # the cap was applied. The rendering is wrapped because the
                # `done` send below sits outside this handler: a throw while
                # formatting would skip it and strand the host on fd 3 until
                # maxWallMs (see _make_failure_reporter).
                "message": safe_model_traceback(exc, max_value_bytes),
            },
        }

    # Flush any print output not terminated by a newline (a traceback always
    # ends in one, but `print(x, end="")` or a bare write may not), so the
    # final partial line is not silently dropped. The success path already
    # flushed before framing the value; this is an idempotent no-op there and
    # the flush the exception path needs.
    #
    # Guarded because `done` is ALREADY DECIDED here: on the exception path the
    # handler above built it, and a flush that raises (its join/encode under
    # memory pressure, after the program left a near-maxLogBytes pending and then
    # allocated toward RLIMIT_AS) would skip `send_done` and downgrade a run the
    # child already classified as `exception` into a host-side `worker-exit`.
    # Losing the log tail is the lesser outcome, and the marker the ledger
    # already pushed still reports the truncation. Same rule as
    # `_make_failure_reporter`: a settled verdict must not be swallowed by the
    # reporting that follows it.
    for _flush in (flush_out, flush_err, _stdout_orig, _stderr_orig):
        if _flush is None:
            continue
        try:
            _flush()
        except _BaseException:  # noqa: BLE001 -- swallow ONLY the log tail; `done` must reach the host; `_BaseException` is a pre-program local
            pass
    reply_task.cancel()
    send_done(done)


async def _pump_replies(
    channel: ProtocolChannel,
    pending: dict[int, tuple[asyncio.AbstractEventLoop, asyncio.Future[Any]]],
    pending_lock: "threading.Lock",
    # The frame reader is a bound method captured by _run BEFORE the program
    # runs (see the create_task site), so a rebind of the class attribute cannot
    # redirect it.
    _read_frame: Any,
    # Bound as DEFAULT ARGUMENTS so they are captured at def/import time, before
    # ANY model code runs. This bootstrap IS `__main__`, so `__main__.RuntimeError
    # = ...` (or `__main__._BindingRejection`, `__main__.str`, `__main__.bool`)
    # as a program top-level statement would otherwise rebind the module globals
    # these clauses resolve at runtime. A body-local `X = X` binding is too late:
    # `_run` reaches `await __dsh_main__` (whose top-level statements run first)
    # with no suspension point after `create_task`, so the model's rebind executes
    # before the pump body. Defaults are evaluated in the enclosing scope at def
    # time, truly before the program.
    _RuntimeError: Any = RuntimeError,
    _BindingRejection: Any = _BindingRejection,
    _str: Any = str,
    _bool: Any = bool,
) -> None:
    """Background task: read reply frames and settle pending futures.

    Cancelled after ``done`` is posted. Unknown ids and post-settlement replies
    are ignored (mirrors the worker backend's hostile-peer stance, though here
    the host is the trusted side; the guards defend against races).

    A pending Future may belong to a loop other than this pump's — the model can
    call a binding from a thread running its own loop (``asyncio.run(tools.x())``).
    ``asyncio.Future`` is not thread-safe, so the completion is scheduled on the
    Future's OWN loop via ``call_soon_threadsafe`` rather than mutated here; a
    direct ``set_result`` would never wake the waiting loop and the call would
    hang to the wall clock. The ``pop`` shares ``pending_lock`` with ``dispatch``
    so a reply cannot race the claim that registers its id.
    """

    def complete(fut: asyncio.Future[Any], ok: bool, value: Any, message: Any) -> None:
        # Runs on the Future's own loop. `done()` re-checked here because
        # cancellation or a duplicate reply may have settled it between the pop
        # and this callback.
        if fut.done():
            return
        if ok:
            fut.set_result(value)
        else:
            fut.set_exception(_BindingRejection(_str(message)))

    while True:
        frame = await _read_frame()
        if frame is None:
            return
        if frame.get("type") != "reply":
            continue
        with pending_lock:
            entry = pending.pop(frame.get("id"), None)
        if entry is None:
            continue
        loop, fut = entry
        ok = _bool(frame.get("ok"))
        value = frame.get("value")
        message = frame.get("message")
        try:
            loop.call_soon_threadsafe(complete, fut, ok, value, message)
        except _RuntimeError:  # `_RuntimeError` is a pre-program local, not a rebindable module global
            # The Future's loop has already closed — the thread that ran
            # `asyncio.run(tools.x(...))` finished (its coroutine was cancelled
            # or it exited) before this reply arrived, so nothing awaits the
            # Future and the reply is moot. Drop it; scheduling onto a closed
            # loop raises RuntimeError, and letting that escape would kill the
            # pump and strand every later reply — the exact failure class this
            # cross-loop delivery exists to prevent. An abandoned call's pending
            # entry is not leaked: it is popped here when its reply arrives
            # (dispatch's cancellation does not remove it), so stranded entries
            # are bounded by the number of calls THIS run itself issued.
            continue


def _encode_json_plain(value: Any) -> str:
    """Encode JSON-plain data iteratively, byte-identical to compact ``json.dumps``.

    ``json.dumps`` recurses one Python frame per nesting level and raises
    ``RecursionError`` a few thousand levels deep, but the seam's
    ``CodeJsonValue`` has no depth limit — a valid deeply nested completion or
    call argument below the byte budget must cross intact (the host uses the
    same iterative idiom in ``protocol.ts``). Accepts what the callers already
    validated or constructed: ``None``/``bool``/``int``/finite ``float``/
    ``str``, exact ``list``/``tuple``, and exact ``dict`` with ``str`` keys.
    Scalar encoding delegates to ``json.dumps`` (string escaping, float repr)
    so the bytes match; non-finite floats still raise ``ValueError`` exactly
    like ``allow_nan=False``.

    Containers are classified by EXACT type and traversed through the unbound
    built-in methods rather than the instance's own: a ``dict``/``list``
    subclass can override ``items``, ``keys``, ``__iter__``, ``__len__``, or
    ``__getitem__``, and the validators only see the container it subclasses,
    so an instance-method call here could emit different data than the walk
    that metered and approved it. ``_check_done_value`` and
    ``_lossless_json_violation`` reject subclasses outright, so this path only
    ever sees exact containers; classifying on exact type keeps that agreement
    checkable at one glance instead of resting on the caller.
    """

    # O(DEPTH) auxiliary space, not O(width). A container pushes ONE cursor frame
    # that pulls its children one at a time and writes each into the shared buffer,
    # rather than one stack entry (plus a separator marker) per child: a flat
    # `[0] * 6_000_000` encodes to ~12 MB but per-element frames are ~400 MB — an
    # RLIMIT_AS death on a value `_check_done_value` already admitted (it walks by
    # depth as well). The output string is the only width-proportional
    # allocation, and its size the caller metered within budget. `io.StringIO`
    # accumulates without the intermediate `"".join(chunks)` second copy. A cursor
    # frame is [kind, iterator, wrote_any]; a visit frame is (VISIT, value).
    buffer = io.StringIO()
    exhausted = object()
    visit, list_cursor, dict_cursor = 0, 1, 2
    stack: list[Any] = [(visit, value)]
    while stack:
        frame = stack.pop()
        kind = frame[0]
        if kind == list_cursor:
            iterator, wrote_any = frame[1], frame[2]
            child = next(iterator, exhausted)
            if child is exhausted:
                buffer.write("]")
                continue
            if wrote_any:
                buffer.write(",")
            else:
                frame[2] = True
            stack.append(frame)
            stack.append((visit, child))
            continue
        if kind == dict_cursor:
            iterator, wrote_any = frame[1], frame[2]
            entry = next(iterator, exhausted)
            if entry is exhausted:
                buffer.write("}")
                continue
            key, item = entry
            if wrote_any:
                buffer.write(",")
            else:
                frame[2] = True
            buffer.write(_dump_scalar(key))
            buffer.write(":")
            stack.append(frame)
            stack.append((visit, item))
            continue
        current = frame[1]
        current_type = type(current)
        if current_type is list or current_type is tuple:
            buffer.write("[")
            stack.append([list_cursor, iter(current), False])
        elif current_type is dict:
            buffer.write("{")
            stack.append([dict_cursor, iter(dict.items(current)), False])
        else:
            buffer.write(_dump_scalar(current))
    return buffer.getvalue()


def _dump_scalar(value: Any) -> str:
    """One scalar as compact JSON, byte-compatible with the host's encoder.

    ``ensure_ascii=False`` keeps non-ASCII text as raw UTF-8 — the default
    backslash-u escaping would make the child count ``"é"`` as 8 bytes where
    the host meter (and the worker backend) count its UTF-8 JSON form as 4,
    splitting the budget the two sides are supposed to share. Strings route
    through :func:`_dump_string`, which restores the escaping for the one class
    of character UTF-8 cannot hold. Floats route through :func:`_dump_float`
    because CPython's ``repr`` and ECMAScript's Number-to-String disagree on
    spelling.

    Dispatch is on EXACT type, matching the validators: a ``float`` subclass
    reaching :func:`_dump_float` would have its overridden ``__repr__`` read as
    the number's digits, so ``F(2.5)`` whose ``__repr__`` returns ``"1.0"``
    would serialize as ``1``. ``json.dumps`` then refuses any subclass by
    ``TypeError`` instead of emitting a value nothing validated; the callers
    reject subclasses first, so this is the encoder refusing to be the place a
    validation gap turns into corrupted output.
    """

    if type(value) is float:
        return _dump_float(value)
    if type(value) is str:
        return _dump_string(value)
    if value is None or type(value) is bool or type(value) is int:
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    raise TypeError(f"unsupported type ({type(value).__name__})")


# A surrogate code unit, and an adjacent high-low pair. Python stores an astral
# character as ONE code point, so a surrogate reaching these patterns is either
# lone or half of a pair the program spelled out code unit by code unit.
_SURROGATE = re.compile("[\ud800-\udfff]")
_SURROGATE_PAIR = re.compile("[\ud800-\udbff][\udc00-\udfff]")


def _combine_surrogate_pair(match: re.Match[str]) -> str:
    """Fold one spelled-out high-low pair into the astral code point it names."""

    high, low = match.group(0)
    return chr(0x10000 + ((ord(high) - 0xD800) << 10) + (ord(low) - 0xDC00))


def _dump_string(text: str) -> str:
    """One string as compact JSON, byte-identical to the host's ``JSON.stringify``.

    ``ensure_ascii=False`` cannot render a surrogate code unit: UTF-8 has no
    encoding for one, so the frame write would raise and the run would strand
    until the wall clock. JSON carries it as the ASCII escape ``\\ud800``, which
    the host's ``JSON.parse`` reads back as the same UTF-16 code unit and its
    ``JSON.stringify`` re-emits identically — so the shared seam
    (``CodeJsonValue``, ``snapshotJsonValue``, the worker backend) keeps a
    lone-surrogate string instead of failing the value. An adjacent high-low
    pair is folded into its astral code point FIRST: the host holds strings as
    UTF-16, where those two code units and the single character are the same
    string, and the raw 4-byte form is what the host would emit — escaping the
    halves separately would charge 12 bytes against a budget the host meters at
    4. Every remaining surrogate is lone and becomes six ASCII bytes, matching
    the host exactly.
    @param text: the string to encode.
    @return: its compact JSON form, always UTF-8-encodable.
    """

    rendered = json.dumps(text, ensure_ascii=False)
    if _SURROGATE.search(rendered) is None:
        return rendered
    return _SURROGATE.sub(
        lambda match: "\\u%04x" % ord(match.group(0)),
        _SURROGATE_PAIR.sub(_combine_surrogate_pair, rendered),
    )


# How many bytes each byte that needs escaping adds beyond its raw self, as a
# ready-made (byte, surcharge) list so :func:`_json_string_cost` walks no
# branches per pass. ``"`` and ``\\`` take a one-character prefix; the five C0
# controls with a shorthand (``\\b\\f\\n\\r\\t``) likewise; every other C0
# control becomes a six-character ``\\uXXXX``.
_JSON_ESCAPE_SURCHARGES = [
    (bytes((byte,)), 1 if byte in b'"\\\b\f\n\r\t' else 5)
    for byte in [*range(0x20), ord('"'), ord("\\")]
]

# Per-byte JSON-string serialized cost (the byte itself plus its escape
# surcharge), indexed by byte value. Lets :func:`_cap_message` accumulate the
# serialized cost of a growing prefix in one O(1) step per byte without building
# the escaped form. A non-ASCII byte stays raw (cost 1); a C0 control or ``"``/
# ``\\`` carries its surcharge from :data:`_JSON_ESCAPE_SURCHARGES`.
_JSON_BYTE_COST = [1] * 256
for _escaped_byte, _surcharge in _JSON_ESCAPE_SURCHARGES:
    _JSON_BYTE_COST[_escaped_byte[0]] = 1 + _surcharge


def _json_str_cost(text: str) -> int:
    """Byte length of ``text``'s JSON string form, WITHOUT building that form.

    The str-side twin of :func:`_json_string_cost`, for the completion-value
    meter. Measuring by materializing ``_dump_string(text).encode()`` allocates
    the escaped copy plus its encode -- for a NUL-heavy string that is ~6x the
    original each, so metering a value the budget would have REJECTED could
    itself breach ``RLIMIT_AS`` and report ``exception`` where the contract
    promises ``output-limit``.

    The common case encodes once (~1x, well inside the load gate's envelope) and
    counts escapes with the same C-level passes :func:`_json_string_cost` uses.
    A string carrying surrogate code units has no UTF-8 form at all, so it takes
    the exact path :func:`_dump_string` defines: fold each spelled-out high-low
    pair into its astral character first (the host meters that as its raw 4-byte
    form), then charge six ASCII bytes for every surviving lone surrogate and
    count the rest from its encodable remainder.
    @param text: the string to measure.
    @return: the byte length of its JSON string form, quotes included.
    """

    try:
        return _json_string_cost(text.encode("utf-8"))
    except UnicodeEncodeError:
        pass
    folded = _SURROGATE_PAIR.sub(_combine_surrogate_pair, text)
    # Remove the lone surrogates first, then count them as the length
    # difference: `_SURROGATE.findall(folded)` materialized one single-character
    # string PER surrogate, so a surrogate-dense value near the budget
    # (millions of lone surrogates, each serializing to six bytes) allocated
    # millions of objects before the meter returned -- an RLIMIT_AS death
    # surfacing as `exception` instead of the promised `output-limit`. After
    # pair-combining, every remaining surrogate is lone and exactly one code
    # point, so the removed length is the count, and the `without` string is
    # needed for the meter anyway.
    without = _SURROGATE.sub("", folded)
    lone = len(folded) - len(without)
    # Six ASCII bytes per lone surrogate; the remainder is ordinary text whose
    # own quotes are dropped here because the outer call adds them once.
    return _json_string_cost(without.encode("utf-8")) + lone * 6


def _json_string_cost(raw: bytes) -> int:
    """UTF-8 byte length of one string's JSON form, WITHOUT building that form.

    Used by :class:`LogBuffer` to charge a log entry what it will actually cost
    on the wire. Building ``json.dumps(text)`` to measure it would allocate a
    second copy up to six times the original — the very allocation the ledger's
    cheap pre-check exists to avoid, and enough to breach ``RLIMIT_AS`` on a
    large control-heavy line. Counts exactly what :func:`_dump_scalar`'s
    ``ensure_ascii=False`` output holds: the two quotes, each escaped byte's
    surcharge from :data:`_JSON_ESCAPE_SURCHARGES`, and the raw bytes themselves
    (non-ASCII stays raw, so its UTF-8 length already counts). Uses a fixed
    number of C-level ``count`` passes — allocating nothing, unlike a
    ``translate`` filter — because the caller admits up to ~4x the remaining
    budget of bytes here and a per-byte Python loop over it would cost more than
    the encode being avoided.
    @param raw: the entry's UTF-8 bytes.
    @return: the byte length of its JSON string form, quotes included.
    """

    extra = 0
    for byte, surcharge in _JSON_ESCAPE_SURCHARGES:
        extra += raw.count(byte) * surcharge
    return len(raw) + 2 + extra


def _dump_float(value: float) -> str:
    """One finite float in ECMAScript ``Number::toString`` spelling.

    CPython's ``repr`` and the host's ``String(number)`` name the same double
    differently: ``1.0`` is ``"1.0"`` here but ``"1"`` there, ``1e-07`` pads the
    exponent the host writes as ``1e-7``, and ``1e+21``/``2**60`` differ again.
    Since the child meters the completion value against ``maxValueBytes`` and
    the host re-meters the frame it parses, any spelling difference splits the
    shared budget: ``return 1.0`` under ``maxValueBytes: 1`` used to be reported
    as ``output-limit`` by the child while the host would have counted the
    one-byte ``1`` it actually receives. Both sides also emit these bytes (the
    child through :func:`_encode_json_plain`, the host through
    ``encodeJsonPlain``), so the fix has to be in the shared speller, not in the
    meter.

    Implements ECMA-262 ``Number::toString`` radix 10 directly: ``repr``
    already yields the shortest round-tripping decimal digits, and ``Decimal``
    splits them into the significand ``s`` (``digits``, ``k`` of them) and
    decimal exponent ``n`` the spec's cases select on. The integral values above
    the JS safe range take the host's BigInt branch, whose exact digits differ
    from the shortest-round-trip form (``2**60`` prints ``...846976``, not
    ``...847000``).
    """

    if value != value or value in (float("inf"), float("-inf")):
        # json.dumps(allow_nan=False) raises the same way; the callers reject
        # non-finite floats before metering, so this is unreachable defense.
        raise ValueError("Out of range float values are not JSON compliant")
    if value == 0.0:
        # Covers -0.0 too; callers reject it as non-lossless before this point.
        return "0"
    if value < 0:
        return "-" + _dump_float(-value)
    if value.is_integer() and value > float(2**53 - 1):
        # The host's BigInt branch: exact digits, not shortest-round-trip.
        return str(int(value))
    parts = Decimal(repr(value)).normalize(context=_FLOAT_CONTEXT).as_tuple()
    digits = "".join(str(digit) for digit in parts.digits)
    k = len(digits)
    n = parts.exponent + k
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * -n + digits
    exponent = ("+" if n - 1 >= 0 else "-") + str(abs(n - 1))
    return (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + exponent


def _check_done_value(value: Any, max_bytes: int):
    """Meter a completion value's JSON byte size AND validate its lossless-JSON
    shape in one bounded post-order walk; return ``None`` when it passes.

    Folds what was formerly a losslessness walk followed by a separate byte
    meter into one pass. Running the losslessness walk first materialized one
    traversal tuple per element before any size cap: ``return [0] * 2000000``
    under ``maxValueBytes: 64`` allocated millions of frames (an RLIMIT_AS
    death) before the meter could reject it. Folding the byte bound into the
    walk rejects over-budget BEFORE enqueuing a container's children — every
    element is at least one JSON byte — so the walk stays O(cap). Same
    JS-double-exact integer boundary, cycle detection (a leave marker pops each
    container off ``on_path``), and type rejections as
    :func:`_lossless_json_violation`, and the same byte accounting as
    :func:`_encode_json_plain`. :func:`_lossless_json_violation` stays for the
    binding-argument path, which carries no size cap.

    EVERY type here is matched EXACTLY, containers and scalars alike, so a
    subclass is rejected as an unsupported type rather than admitted by
    ``isinstance``. A subclass can override the operators and methods this walk
    and the encoder call, and they need not agree: a populated ``dict``
    subclass whose ``items()`` returns ``[]`` would meter as ``{}``; a ``float``
    subclass overriding ``__repr__`` passes the non-finite and negative-zero
    checks by its real value but serializes as whatever the override says, since
    :func:`_dump_float` reads ``repr``; an ``int`` subclass overriding ``__gt__``
    and ``__lt__`` slips past the JS-safe-range bound while ``json.dumps``
    emits its true C-level digits, so ``2**53 + 1`` reaches the host as
    ``...992``; a ``str`` subclass overriding ``__len__`` returns 0 from the
    pre-encode lower bound and admits an arbitrarily large string. In each case
    the value the host receives differs from the one this walk approved. The
    worker backend rejects the equivalent shapes by prototype identity and
    ``typeof`` (``hasPlainObjectPrototype`` in ``worker-json.ts``); a ``bool``
    is checked before ``int`` because it is an ``int`` subclass that IS
    lossless JSON.

    Returns ``("invalid-output", message)`` for a non-lossless value,
    ``("output-limit", message)`` once the size crosses ``max_bytes``, or
    ``None`` when the value is lossless JSON within budget.

    Metering and validation interleave in this single traversal: each member is
    costed the moment it is visited, and it is rejected the moment it trips
    either check. A value that holds BOTH an over-budget member and an
    invalid-typed member therefore resolves to whichever tripped FIRST in
    visit order — both are rejects, and neither kind claims priority over the
    other, so that first-trip order is not part of the seam contract; the
    host side independently re-measures the value it receives.
    """

    js_safe = 2**53 - 1

    def invalid(reason: str):
        return ("invalid-output", f"program completion must be lossless JSON ({reason})")

    over_budget = ("output-limit", f"completion value exceeded {max_bytes} bytes")

    total = 0
    on_path: set[int] = set()
    # The walk uses O(DEPTH) space, not O(width). A container pushes ONE cursor
    # frame that pulls its children one at a time, rather than one traversal
    # frame per child: a flat `[0] * 6_000_000` serializes to ~12 MB (well within
    # a modest budget) but one tuple per element is ~380 MB — an RLIMIT_AS death
    # on a value the byte meter would admit, the very inversion this meter exists
    # to prevent. A cursor frame is (kind, container, iterator); a visit frame is
    # (VISIT, value, None). The upfront structural bound still rejects a wide
    # forgery before any iteration begins.
    exhausted = object()
    visit, list_cursor, dict_cursor = 0, 1, 2
    stack: list[tuple[int, Any, Any, Any]] = [(visit, value, None, None)]
    while stack:
        frame = stack.pop()
        kind = frame[0]
        if kind == list_cursor:
            container, iterator = frame[1], frame[2]
            child = next(iterator, exhausted)
            if child is exhausted:
                on_path.discard(id(container))
                continue
            # Resume this cursor after the child is fully walked; the child goes
            # on top so it is visited next (order does not affect the byte total).
            stack.append(frame)
            stack.append((visit, child, None, None))
            continue
        if kind == dict_cursor:
            container, iterator, seen = frame[1], frame[2], frame[3]
            entry = next(iterator, exhausted)
            if entry is exhausted:
                on_path.discard(id(container))
                continue
            key, item = entry
            # Only an EXACT str key survives: bool and int coerce or raise, and a
            # str SUBCLASS can override the ``__len__`` the bound below reads while
            # the encoder emits its real characters.
            if type(key) is not str:
                return invalid(f"non-string dict key ({type(key).__name__})")
            # The key's JSON form folds a spelled-out surrogate pair into its
            # astral code point (`_dump_string`), so two DIFFERENT Python keys —
            # the two code units and the single character — encode to the same
            # JSON member, and the host's JSON.parse silently drops one of them.
            # That is a lossless-JSON violation, so the collision is rejected
            # here, before any encoding.
            combined_key = _SURROGATE_PAIR.sub(_combine_surrogate_pair, key)
            if combined_key in seen:
                return invalid("duplicate dict key after surrogate-pair combining")
            seen.add(combined_key)
            # The same string lower bound, before escaping the key.
            if total + len(key) + 3 > max_bytes:
                return over_budget
            # Same counting rule as the string branch: a control-heavy KEY
            # expands just as far, and `_dump_scalar` on a str is `_dump_string`.
            total += _json_str_cost(key) + 1
            if total > max_bytes:
                return over_budget
            stack.append(frame)
            stack.append((visit, item, None, None))
            continue
        current = frame[1]
        if current is None or type(current) is bool:
            total += len(_dump_scalar(current).encode("utf-8"))
        elif type(current) is str:
            # Lower-bound BEFORE materializing the escaped form: every character
            # is at least one UTF-8 byte plus the two quotes, so a huge or
            # control-heavy string (whose escaped copy expands severalfold) is
            # rejected without allocating that copy.
            if total + len(current) + 2 > max_bytes:
                return over_budget
            # A lone surrogate has no UTF-8 form but a lossless JSON one — the
            # ASCII ``\uXXXX`` escape :func:`_dump_string` emits — so it is
            # metered, not rejected, matching the shared seam. Metered by
            # COUNTING, not by building the escaped form: that copy plus its
            # encode is ~6x the original for a control-heavy string, so measuring
            # a value the budget rejects could breach RLIMIT_AS and surface as
            # `exception` instead of the promised `output-limit`.
            total += _json_str_cost(current)
        elif type(current) is int:
            # The canonical boundary accepts every JS-double-exact value: an int
            # outside +-2**53-1 is fine IFF the double round-trip is exact.
            if current > js_safe or current < -js_safe:
                try:
                    exact = int(float(current)) == current
                except OverflowError:
                    exact = False
                if not exact:
                    return invalid("integer not exactly representable as a JavaScript number")
            total += len(_dump_scalar(current).encode("utf-8"))
        elif type(current) is float:
            if current != current or current in (float("inf"), float("-inf")):
                return invalid("non-finite float")
            # JSON turns -0.0 into a sign the host parses back to JS -0; the
            # canonical boundary rejects it, so this side must too.
            if current == 0.0 and math.copysign(1.0, current) < 0:
                return invalid("negative zero")
            total += len(_dump_scalar(current).encode("utf-8"))
        elif type(current) is list:
            if id(current) in on_path:
                return invalid("circular reference")
            count = len(current)
            total += 2 + (count - 1 if count > 1 else 0)
            # Reject over-budget BEFORE iterating: every element serializes to at
            # least one byte, so a wide flat forgery fails here without pulling a
            # single child.
            if total + count > max_bytes:
                return over_budget
            on_path.add(id(current))
            stack.append((list_cursor, current, iter(current), None))
        elif type(current) is dict:
            if id(current) in on_path:
                return invalid("circular reference")
            # ``len`` without materializing ``current.items()``: that list
            # allocates one tuple per member before the bound below could run,
            # recreating the spike the bound exists to stop.
            count = len(current)
            total += 2 + (count - 1 if count > 1 else 0)
            # Same pre-iterate bound: each entry contributes a quoted key
            # (>= 2 bytes), a colon, and a >= 1-byte value. ``iter`` on the items
            # view is O(1); the cursor meters each key as it is pulled.
            if total + count * 4 > max_bytes:
                return over_budget
            on_path.add(id(current))
            # The seen-set holds one combined key per member — O(keys), the same
            # order as the dict itself — so the surrogate-collision check below
            # can detect two keys that fold to one JSON member.
            stack.append((dict_cursor, current, iter(current.items()), set()))
        else:
            # tuple, set, or any other type: not round-trippable JSON.
            return invalid(f"unsupported type ({type(current).__name__})")
        if total > max_bytes:
            return over_budget
    return None


def _lossless_json_violation(value: Any) -> str | None:
    """Return why ``value`` is not lossless JSON, or ``None`` when it is.

    ``json.dumps`` succeeding is NOT proof of losslessness: it coerces a
    non-string ``dict`` key to its string form (``{1: "a", "1": "b"}`` collapses
    to one key, silently dropping data), emits non-standard ``NaN``/``Infinity``
    tokens without ``allow_nan=False``, and accepts integers outside JavaScript's
    safe range (``9007199254740993`` becomes ``...992`` once the host parses the
    frame into a JS number). Validate the shape up front so a coercive or lossy
    value fails as ``invalid-output`` instead of round-tripping to something the
    program did not compute. Iterative so deep nesting cannot overflow the stack,
    and it tracks the container ancestry on the current path so a cyclic value is
    reported at once rather than spinning until the CPU budget. Only JSON-plain
    types survive: ``None``/``bool``/JS-safe ``int``/finite ``float``/``str``,
    exact ``list``, and exact ``dict`` with ``str`` keys. Every type matches
    EXACTLY, containers and scalars alike, for the reason
    :func:`_check_done_value` documents: a subclass can override the operators
    and methods a traversal calls, so an ``isinstance`` admission here would
    approve one shape and let the encoder emit another.
    """

    # The canonical boundary accepts every JS-double-exact value: an int
    # outside +-2**53-1 is fine IFF the double round-trip is exact (2**53 or
    # 2**60 survive; 2**53+1 rounds), matching the worker backend.
    js_safe = 2**53 - 1
    # Post-order walk with an explicit "leave" marker: a container's id is added
    # to `on_path` when entered and removed when left, so a back-edge to an
    # ancestor (a cycle) is detected without rejecting a legitimately shared
    # acyclic subtree.
    on_path: set[int] = set()
    # O(DEPTH) auxiliary space, not O(width), for the reason
    # :func:`_check_done_value` documents: this walk runs in ``dispatch`` on
    # MODEL-CONSTRUCTED binding arguments, which no child-side byte budget
    # bounds first (the frame ceiling is the host's, and it applies after this
    # returns). Enqueueing one frame per member would let a legitimate
    # ``[0] * 6_000_000`` argument -- ~17 MB of JSON -- allocate ~366 MB of
    # traversal tuples and die as the program's own MemoryError instead of
    # round-tripping. A container therefore pushes ONE cursor frame holding its
    # iterator; children are pulled one at a time.
    exhausted = object()
    visit, container_cursor = 0, 1
    # A visit frame is (visit, value, None, None); a cursor frame is
    # (cursor, container, iterator, seen-keys-for-dicts).
    stack: list[tuple[int, Any, Any, Any]] = [(visit, value, None, None)]
    while stack:
        kind = stack[-1][0]
        if kind == container_cursor:
            _, container, iterator, seen = stack[-1]
            child = next(iterator, exhausted)
            if child is exhausted:
                # Leaving the container: it is no longer on the current path, so
                # a legitimately shared acyclic subtree is not mistaken for a cycle.
                on_path.discard(id(container))
                stack.pop()
                continue
            if type(container) is dict:
                # The dict cursor yields (key, value): check the key as it is
                # pulled. Only an EXACT str key survives -- int, float, None, and
                # tuple keys coerce or raise, and a str subclass can carry
                # overrides the encoder does not honor.
                key, child = child
                if type(key) is not str:
                    return f"non-string dict key ({type(key).__name__})"
                # The key's JSON form folds a spelled-out surrogate pair into its
                # astral code point (`_dump_string`), so two DIFFERENT Python
                # keys -- the two code units and the single character -- encode
                # to the same JSON member, and the host's JSON.parse silently
                # drops one of them. A lossless-JSON violation, rejected here
                # before any encoding.
                combined_key = _SURROGATE_PAIR.sub(_combine_surrogate_pair, key)
                if combined_key in seen:
                    return "duplicate dict key after surrogate-pair combining"
                seen.add(combined_key)
            stack.append((visit, child, None, None))
            continue
        _, current, _unused, _unused2 = stack.pop()
        if current is None or type(current) is bool:
            continue
        if type(current) is str:
            # Every string is lossless JSON. A lone surrogate has no UTF-8 form,
            # but JSON carries the code unit as its ASCII ``\uXXXX`` escape and
            # :func:`_dump_string` emits exactly that, so the host receives the
            # same code unit the program passed — the same acceptance
            # ``CodeJsonValue``, ``snapshotJsonValue``, and the worker backend
            # already give it.
            continue
        if type(current) is int:
            if current > js_safe or current < -js_safe:
                try:
                    exact = int(float(current)) == current
                except OverflowError:
                    exact = False
                if not exact:
                    return "integer not exactly representable as a JavaScript number"
            continue
        if type(current) is float:
            if current != current or current in (float("inf"), float("-inf")):
                return "non-finite float"
            # JSON serialization turns -0.0 into 0 (or "-0.0" text that the
            # host parses to JS -0), silently changing the sign bit either
            # way; the repository's canonical lossless-JSON boundary and the
            # worker backend both reject it, so this side must too.
            if current == 0.0 and math.copysign(1.0, current) < 0:
                return "negative zero"
            continue
        if type(current) is list or type(current) is dict:
            if id(current) in on_path:
                return "circular reference"
            on_path.add(id(current))
            if type(current) is dict:
                # Keys are checked as the cursor pulls each entry, not in a
                # separate pass: ``current.values()`` would need a second walk,
                # and materializing ``items()`` up front allocates one tuple per
                # member -- the very spike the cursor removes. The seen-set holds
                # one combined key per member -- O(keys), the same order as the
                # dict itself -- for the surrogate-collision check.
                stack.append((container_cursor, current, iter(current.items()), set()))
            else:
                stack.append((container_cursor, current, iter(current), None))
            continue
        return f"unsupported type ({type(current).__name__})"
    return None


def _make_cpu_enforcer() -> Any:
    """Build the CPU post-check over closure-held primitives.

    This bootstrap IS ``__main__``, so model code can reach every one of its
    module globals: ``import __main__; __main__._X = ...`` rebinds the name the
    enforcement would otherwise read at call time, which a plain module-level
    function plus module-level captures made a one-line defeat. The primitives
    therefore live in this factory's locals, which become closure cells of the
    returned function, and :func:`_run` binds the returned function into a
    local of its own frame BEFORE executing the program, so no assignment to
    ``__main__`` changes which callable runs or what it calls. Capture happens
    at import time, before model code runs, so the captured
    ``resource.getrusage``/``signal.signal``/``os.kill`` are the real builtins.

    This raises the cost of defeating the check; it does not make it
    unreachable, and nothing in-process could. A cell is writable through
    ``fn.__closure__[i].cell_contents``, and ``sys._getframe`` walks to
    :func:`_run`'s frame and reads its locals, so a program determined to
    tamper still can — consistent with this backend's documented posture, where
    the in-process interpreter is containment rather than a security boundary
    (§Trust posture in the PTC mode Agent Note). The bounds that model code cannot
    forge are outside the interpreter: the RLIMIT_CPU HARD limit at
    ``cpuSeconds + 1``, whose SIGKILL is undeliverable to a handler and
    unraisable by a process that cannot raise its own hard limit, and the
    host's wall-clock ceiling. This check exists to convert the two cases those
    miss — a program that traps SIGXCPU and settles inside the soft-to-hard
    gap, and a program that spends the budget in DESCENDANTS the kernel never
    charged to this process — from a reported SUCCESS into the same `timeout`
    an untrapped program gets.

    @returns The one-argument enforcement callable, taking `cpuSeconds`.
    """

    getrusage = resource.getrusage
    rusage_self = resource.RUSAGE_SELF
    rusage_children = resource.RUSAGE_CHILDREN
    set_signal = signal.signal
    sig_dfl = signal.SIG_DFL
    sigxcpu = signal.SIGXCPU
    kill = os.kill
    getpid = os.getpid
    # SIGXCPU unmasking primitives for the re-raise below: a program can mask
    # the signal and return past the soft limit, so the re-delivered signal
    # must be unblocked first. Captured here (import time) so a rebind cannot
    # defeat them. The ``getattr``/``None`` guard is defensive against a
    # stripped CPython build (the host refuses win32 at construction, so every
    # platform this backend actually starts on has ``pthread_sigmask``).
    pthread_sigmask = getattr(signal, "pthread_sigmask", None)
    sig_unblock = getattr(signal, "SIG_UNBLOCK", None)

    def die_if_cpu_exhausted(cpu_seconds: int) -> None:
        """Die by re-delivered SIGXCPU when the CPU budget is already spent.

        Two cases reach here as a would-be SUCCESS. A model program can trap
        SIGXCPU and return during the one-second soft-to-hard gap. And
        ``RLIMIT_CPU`` is PER-PROCESS, inherited fresh by every child, so a
        program calling ``subprocess`` or ``os.fork`` multiplies the run's CPU
        budget by the number of descendants it starts: measured with
        ``cpuSeconds: 1``, two sequential busy children burned 2.0
        CPU-seconds and the parent, which had accrued almost no CPU of its own
        while blocked in ``subprocess.wait``, still returned a completion.
        The meter is therefore ``RUSAGE_SELF + RUSAGE_CHILDREN``, the kernel's
        own aggregate, which accumulates the CPU of every REAPED descendant
        (grandchildren included, verified).

        ``getrusage`` is the kernel's own meter (unforgeable from model code),
        and dying by SIGXCPU with the default disposition restored gives the
        host the same kernel-authoritative close signal as the untrapped soft
        limit — classified as `timeout`, after which the host's process-group
        SIGTERM/SIGKILL teardown reaches any surviving descendants. Runs AFTER
        the model program settled, so a program can re-trap SIGXCPU between
        this SIG_DFL and the kill only by running more code, which it no longer
        does. A program that tampers with this callable instead (see
        :func:`_make_cpu_enforcer` on why in-process state cannot be hidden)
        buys at most the remaining soft-to-hard gap: one more CPU second, after
        which the hard limit's SIGKILL lands with no handler possible.

        Checking at settle time rather than sampling mid-run is deliberate:
        both mid-run designs perturb the run they measure. A sampling thread
        cost 72 MiB of virtual address space in the child (8 MiB stack plus a
        64 MiB glibc per-thread malloc arena reservation; measured 30.23 MiB of
        mappings without it against 102.37 MiB with it), and ``RLIMIT_AS``
        counts reserved space, so it silently shrank every run's
        `addressSpaceMb`. A ``SIGALRM`` interval timer costs no mappings but
        makes the program's own syscalls return short under PEP 475 — measured
        a 64 MiB ``os.write`` returning 65536 — which corrupts fd-3 framing.
        The cost of checking only at settle time is that a descendant's CPU is
        detected after it is spent, not while it runs; the host's wall-clock
        ceiling bounds that interval, and a program that never reaps its child
        is bounded by the wall clock alone, since ``RUSAGE_CHILDREN`` counts
        only reaped descendants (verified: a still-running child contributes
        0.0).

        @param cpu_seconds The `cpuSeconds` budget the soft RLIMIT_CPU used.
        """

        own = getrusage(rusage_self)
        kids = getrusage(rusage_children)
        spent = own.ru_utime + own.ru_stime + kids.ru_utime + kids.ru_stime
        if spent >= cpu_seconds:
            # A program can mask SIGXCPU (``pthread_sigmask(SIG_BLOCK, ...)``),
            # burn past the soft limit, and return during the soft-to-hard gap;
            # the re-delivered SIGXCPU below would then stay PENDING and the
            # child would exit normally with a success result. Restore the
            # default disposition BEFORE unblocking: a program that installed a
            # custom handler AND masked the signal has that pending handler run
            # the moment the signal is unblocked (CPython delivers it at the next
            # eval-breaker checkpoint in model code), and it could re-mask or
            # raise — so the disposition must already be SIG_DFL when the signal
            # is released. With SIG_DFL restored first, the pending signal kills
            # the process inside the kernel with no bytecode window; the ``kill``
            # below is the fallback for the never-pending case. ``pthread_sigmask``
            # is ``None``-guarded defensively (every platform this backend starts
            # on has it; the host refuses win32 at construction).
            set_signal(sigxcpu, sig_dfl)
            if pthread_sigmask is not None:
                pthread_sigmask(sig_unblock, (sigxcpu,))
            kill(getpid(), sigxcpu)

    return die_if_cpu_exhausted


_DIE_IF_CPU_EXHAUSTED = _make_cpu_enforcer()


_TRUNCATION_MARKER = "… [truncated]"

# The marker's own UTF-8 size, reserved out of the cap rather than added on top
# of it. Byte-identical to the host's TRUNCATION_MARKER_BYTES; the ellipsis is
# three bytes, so this is 15, not the string's 13 characters.
_TRUNCATION_MARKER_BYTES = len(_TRUNCATION_MARKER.encode("utf-8"))


def _cap_message(message: str, max_bytes: int) -> str:
    """Cap a diagnostic by its SERIALIZED cost, appending the host's marker.

    Metered by the JSON-string cost the ``done`` frame will actually carry, not
    by raw UTF-8 length: the message crosses fd 3 inside a JSON frame where
    control characters escape up to sixfold (a NUL is one raw byte but six as
    ``\\u0000``), so a raw-length cap of ``maxValueBytes`` could serialize to
    roughly six times that and breach the 64 MiB frame parse cap — the silent
    ``worker-exit`` inversion the load-time cap check exists to prevent, and a
    several-hundred-MiB escape allocation besides. The seam's load bound admits
    ``maxValueBytes`` up to ``parse-cap - envelope`` on the premise that both the
    completion value and the diagnostic are metered in serialized bytes, so this
    honors that premise for the diagnostic.

    Encoded with ``errors="replace"`` first: a model exception message can
    contain an unpaired surrogate (``raise Exception("\\ud800")``), and a strict
    encode would throw while BUILDING the failure frame — the run would then
    strand until the wall clock instead of reporting the exception. The marker's
    serialized cost comes OUT of ``max_bytes``, so the returned string's own
    frame form honors the cap; the host meters the same field again on arrival.
    A ``max_bytes`` below the marker's cost yields the marker alone.

    This is the PRODUCING-side cap. The host's receive-side ``capMessage``
    (``src/index.ts``) bills the same field by RAW bytes instead, because its
    output goes into ``CodeRunResult.error.message`` and never re-crosses a
    frame-bounded channel — see that function's JSDoc for the split.
    """

    raw = message.encode("utf-8", errors="replace")
    if _json_string_cost(raw) <= max_bytes:
        return raw.decode("utf-8")
    # Truncating: the result is `prefix + marker`, whose serialized cost is
    # `2 (quotes) + sum(prefix byte costs) + marker cost`. The marker is
    # escape-free, so its cost is its UTF-8 length. Reserve that and the quotes,
    # then take the longest raw prefix whose accumulated per-byte cost fits.
    # `_JSON_BYTE_COST` is per-byte and additive, so the scan is exact and walks
    # at most a budget's worth of bytes, allocating nothing (unlike building the
    # escaped form). `max(0, ...)` handles a `max_bytes` below the marker's own
    # cost, yielding the marker alone.
    content_budget = max(0, max_bytes - 2 - _TRUNCATION_MARKER_BYTES)
    cost = 0
    end = 0
    for end in range(len(raw)):
        cost += _JSON_BYTE_COST[raw[end]]
        if cost > content_budget:
            break
    else:
        end = len(raw)
    # Drop a trailing partial UTF-8 sequence the slice may have cut (continuation
    # bytes are 0b10xxxxxx); `errors="ignore"` renders the clean prefix.
    return raw[:end].decode("utf-8", errors="ignore") + _TRUNCATION_MARKER


# Fixed safety/liveness bound, not a tunable: a model can raise an exception
# with an arbitrarily deep __cause__/__context__ chain, and both the rendering
# walk and format() are linear in chain length. Capping how many links get
# RENDERED keeps traceback formatting from consuming the whole wall budget.
# 100 links is far beyond any legible human traceback.
_MAX_TRACEBACK_CHAIN = 100

# Diagnostic used when rendering the failure itself fails. Built from a fixed
# literal plus the exception CLASS name, never from the exception's own str.
_UNRENDERABLE_DIAGNOSTIC = "<diagnostic rendering failed>"


def _model_traceback(exc: BaseException, max_bytes: int) -> str:
    """Format a model-program failure with only the MODEL's own frames.

    Bootstrap frames carry host-absolute paths — meaningless to the model and
    unstable across machines, so transcripts pinning them cannot replay. They
    appear not only as a leading prefix (the bootstrap's ``exec``/``await``)
    but also interleaved and trailing: an uncaught binding rejection re-raised
    by ``dispatch`` puts bootstrap frames AFTER the model's, and chained
    ``__cause__``/``__context__`` exceptions carry their own stacks. Filter
    every non-``<model>`` frame across the whole chain rather than trimming a
    prefix. A failure with no model frame anywhere (e.g. a SyntaxError raised
    by ``compile``) keeps the standard exception-only rendering.

    Rendering is bounded to ``_MAX_TRACEBACK_CHAIN`` links, cut on the
    ``TracebackException`` COPY, and a marker line announces the truncation.
    Nothing here touches the live exception: an exception class overriding
    ``__setattr__`` would run MODEL code from inside the caller's failure
    handler, and a throw there costs the ``done`` frame (see
    ``_safe_model_traceback``). ``TracebackException`` instances hold no such
    hooks, so clearing their links runs no model code. The walk is iterative,
    so a deep chain cannot overflow the recursion limit.

    ``from_exception`` still copies the WHOLE live chain, at a higher per-link
    cost than building it took. That is bounded by the child's ``RLIMIT_AS``:
    the model must materialize every link (exception object plus traceback)
    before raising, so a chain long enough for the copy to matter is already
    near the address-space cap, and a ``MemoryError`` in the copy lands in the
    caller's fallback rather than stranding the run.
    """

    te = traceback.TracebackException.from_exception(exc)
    # One iterative pass over the copy does both jobs: keep only <model> frames
    # on every linked exception and group member, and cut the chain at the cap.
    found = False
    truncated = False
    pending = [(te, 1)]
    while pending:
        entry, depth = pending.pop()
        kept = [f for f in entry.stack if f.filename == "<model>"]
        entry.stack = traceback.StackSummary.from_list(kept)
        found = found or bool(kept)
        # 3.11+ exception groups (a binding failure inside asyncio.TaskGroup)
        # carry member stacks under `exceptions`, not the dunder links; a group
        # member counts as a link so the cap bounds nesting through both edges.
        members = getattr(entry, "exceptions", None) or ()
        if depth >= _MAX_TRACEBACK_CHAIN:
            if entry.__cause__ is not None or entry.__context__ is not None or members:
                truncated = True
            entry.__cause__ = None
            entry.__context__ = None
            if members:
                entry.exceptions = None
            continue
        for linked in (entry.__cause__, entry.__context__):
            if linked is not None:
                pending.append((linked, depth + 1))
        for member in members:
            pending.append((member, depth + 1))

    def emit():
        if found:
            yield from te.format()
        else:
            yield from traceback.format_exception_only(type(exc), exc)
        if truncated:
            yield f"[dsh-code-runtime-python] exception chain truncated at {_MAX_TRACEBACK_CHAIN} links\n"

    return _join_bounded(emit(), max_bytes)


def _make_failure_reporter() -> Any:
    """Build the failure-diagnostic renderer over closure-held primitives.

    The returned callable renders a model failure diagnostic that cannot itself
    raise. The caller sends the ``done`` frame AFTER its ``except BaseException``
    block, so anything thrown while rendering the diagnostic skips the send
    entirely: the host then blocks on fd 3 until ``maxWallMs`` and reports a
    timeout instead of the exception that actually happened. Rendering runs
    model code by design (``format()`` reaches ``__str__``, ``__repr__`` and
    ``__notes__``) and allocates under ``RLIMIT_AS``, so it must be treated as
    able to throw.

    The fallback names the exception CLASS and a fixed literal — no ``str(exc)``
    and no ``format_exception_only``, both of which reach the model's
    ``__str__``. A ``__name__`` that is not exactly ``str`` (a metaclass
    property can return anything, or raise) is discarded rather than
    formatted, so no override runs on this path either.

    The factory exists for the same reason :func:`_make_cpu_enforcer` does: this
    bootstrap IS ``__main__``, so ``import __main__; __main__._X = ...`` rebinds
    any module global a call-time lookup would read. On this path a rebind is
    worst — the handler's own reporter, and everything the reporter reaches,
    would run model code outside any guard, and a throw there costs the ``done``
    frame. The traceback formatter, the byte cap and the fallback literal
    therefore become closure cells captured at import time, before model code
    runs, and :func:`_run` binds the returned callable into a local of its own
    frame. A frame local is not a module attribute, so no assignment to
    ``__main__`` changes which callable runs or what it calls. This defeats the
    one-line rebind, not a determined ``sys._getframe`` walk; the unforgeable
    bound is the host wall clock.
    """

    cap_message = _cap_message
    model_traceback = _model_traceback
    unrenderable = _UNRENDERABLE_DIAGNOSTIC
    # The exception class the guards below catch is bound into a closure cell
    # here, at import time, before model code runs. `safe_model_traceback` runs
    # AFTER the program (which is `__main__`) may have rebound the module global
    # `BaseException`, so `except BaseException` would resolve the rebound class
    # and a render-time throw could escape — losing the done frame. A closure cell
    # is not reachable by `__main__._X = ...`, so the catch is immune.
    _BaseException = BaseException

    def safe_model_traceback(exc: BaseException, max_bytes: int) -> str:
        try:
            return cap_message(model_traceback(exc, max_bytes), max_bytes)
        except _BaseException:  # noqa: BLE001 -- a throw here would cost the done frame
            pass
        try:
            raw_name = type(exc).__name__
            # Slice BEFORE interpolating. A metaclass `__name__` property can
            # return an arbitrarily long string, and both the f-string and
            # `cap_message`'s encode would copy it whole — under a tight
            # RLIMIT_AS either allocation can raise MemoryError, and this is the
            # LAST fallback, so a throw here costs the `done` frame outright and
            # the run misreports as an exit or a timeout. The slice is a
            # code-unit prefix, which bounds the bytes at 4x, and the following
            # `cap_message` still applies the exact byte cap.
            name = raw_name[:_MAX_FALLBACK_NAME_CHARS] if type(raw_name) is str else "<unknown>"
        except _BaseException:  # noqa: BLE001 -- a raising __name__ must not cost the done frame
            name = "<unknown>"
        # Wrapped for the same reason: `cap_message` encodes, and its allocation
        # is the only step left that can still fail. The fixed literal needs no
        # budget, so it can always be delivered.
        try:
            return cap_message(f"{name}: {unrenderable}", max_bytes)
        except _BaseException:  # noqa: BLE001 -- the done frame outranks the diagnostic's detail
            return unrenderable

    return safe_model_traceback


_SAFE_MODEL_TRACEBACK = _make_failure_reporter()


def _join_bounded(lines, max_bytes: int) -> str:
    """Join formatter output, stopping once the budget is comfortably passed.

    ``format()`` yields lines lazily; consuming it whole for an exception
    carrying a huge message would materialize the full text only for
    ``_cap_message`` to throw it away — enough over-shoot to exhaust
    ``RLIMIT_AS``. Stop after the accumulated CHARACTER count passes the byte
    budget (chars lower-bound UTF-8 bytes); the caller's ``_cap_message``
    does the exact byte-level cut.
    """

    chunks: list[str] = []
    total = 0
    for line in lines:
        # A single yielded line can itself dwarf the budget (the exception
        # message rides in one line): keep only the prefix it can ever need.
        if len(line) > max_bytes + 1:
            line = line[: max_bytes + 1]
        chunks.append(line)
        total += len(line)
        if total > max_bytes:
            break
    return "".join(chunks)


def _done_with_value(
    value: Any,
    max_value_bytes: int,
    # Bound as DEFAULT ARGUMENTS so they are captured at import time, before
    # model code runs: `_done_with_value` runs AFTER the program (which is
    # `__main__`) may have rebound `__main__._check_done_value` or
    # `__main__._encode_json_plain`, and a module-global lookup at call time
    # would let a one-line rebind rewrite a legitimate success into an
    # `exception`. Defaults are evaluated at def time, so they are the originals.
    _check_done_value: Any = _check_done_value,
    _encode_json_plain: Any = _encode_json_plain,
    _cap_message: Any = _cap_message,
) -> dict[str, Any] | str:
    """Build the terminal done frame under the seam's lossless-JSON contract.

    A completion value returned by the program (``None`` when it returns
    nothing) that is not lossless JSON fails the run as ``invalid-output``; a
    serialized value beyond ``max_value_bytes`` fails as ``output-limit``.
    Substituting a ``repr`` or truncated string would be a silent lie about
    what the program computed, so both paths refuse instead (mirroring the
    worker backend's contract). ``None`` crosses as an exact JSON ``null``.

    The SUCCESS path returns the whole ``"done"`` frame as an ALREADY-ENCODED
    JSON string: the admitted value is serialized here, at its validation
    point, rather than handed to ``send_sync`` to re-walk later. The program
    can keep mutating the returned list/dict from a daemon thread or signal
    handler after it returns, so a second traversal held at a later point
    would be a TOCTOU — a mutation into a non-JSON type would let that later
    encode throw outside the settlement handler and downgrade the run
    host-side to ``worker-exit``. Serializing once, inside the try that wraps
    this call, closes the window: if a concurrent mutation makes the encode
    throw, the exception handler classifies it as ``exception``, and once the
    string is produced the frame is sent verbatim with no further touching of
    the live value. Returns a ``dict`` only for a rejection (an error frame
    carries no live model value and is safe to send via ``send_sync``).
    """

    # One bounded walk folds the losslessness check and the byte meter (mirrors
    # the host's checkDoneValue): the former split ran the full losslessness
    # walk first, materializing one tuple per element for a wide completion
    # before the size cap could reject it — an RLIMIT_AS death on a value the
    # meter would have refused. The value's escaped JSON is then produced in the
    # SAME call, so the admitted value is serialized exactly once (see above);
    # its size the walk proved within budget. Iterative like the encoder, so a
    # valid completion deeper than the recursion limit still checks.
    rejection = _check_done_value(value, max_value_bytes)
    if rejection is not None:
        kind, message = rejection
        # The rejection diagnostic is capped like an exception message: a
        # reason embedding a hostile class name (a huge `type(value).__name__`)
        # could otherwise make the done frame exceed the host's frame parse cap
        # and be silently dropped — an invalid-output run misreported as a
        # worker-exit.
        return {"type": "done", "error": {"kind": kind, "message": _cap_message(message, max_value_bytes)}}
    # Pre-encode the value at the validation point (not in `_run`'s later send,
    # which is outside the try): see the TOCTOU note in the docstring. The value
    # is JSON-plain by construction, so `_encode_json_plain` is the encoder.
    return '{"type": "done", "value": ' + _encode_json_plain(value) + "}"


def main() -> None:
    channel = ProtocolChannel(PROTOCOL_FD)
    asyncio.run(_run(channel))


if __name__ == "__main__":
    main()
