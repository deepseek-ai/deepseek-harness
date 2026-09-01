# Agent Note: the code-runtime-python fd-3 frame protocol

Status: implemented

The CPython code runtime now lives at `packages/experimental/code-runtime-python` (private, npm name `@deepseek-ai/dsh-experimental-code-runtime-python`); promotion to a released package follows the experimental-packages decision.

English | [中文](2026-07-31-code-runtime-python-fd3-protocol.zh.md)

## Problem

`@deepseek-ai/dsh-experimental-code-runtime-python` owns the wire protocol intended for a CPython code-runtime provider. Such a provider runs each model program in a fresh `python3 -I` subprocess and bridges binding calls and completion values over the child's fd 3. The host cannot trust that channel: model code has full access to fd 3 and can forge any frame, so every inbound frame is hostile input that the host must validate and rebuild before reading. The protocol also has to carry lossless JSON without the depth limit `JSON.stringify` and `json.dumps` impose, because the seam's `CodeJsonValue` is depth-unbounded.

The private experimental package contains both the protocol and runtime implementation: `PythonCodeRuntime` (the plugin's default export), the `python3 -I` subprocess path, and the Python-side JSON codec all live in `@deepseek-ai/dsh-experimental-code-runtime-python`. The protocol builds on the [portable identifier seam](2026-07-31-code-runtime-portable-identifier-seam.md).

## Decision

`src/protocol.ts` is the host side of the wire vocabulary and its hostile-frame codec:

- **`validateChildFrame`** shape-validates and REBUILDS every inbound frame. The compile-time union means nothing on fd 3 — a forged frame can carry `null`, poisoned fields, or omit required ones — so each accepted frame is reconstructed field by field: forged extras never ride along, a non-finite call id can never be echoed into a reply, and junk returns `undefined` to be dropped rather than throwing in the host's message handler.
- **`encodeJsonPlain` / `checkDoneValue` / `hasUnsafeIntegerToken` / `hasNonLosslessNumber`** are the lossless-JSON codec and meters. They traverse iteratively (an explicit stack, not recursion) so a deep value below the byte budget crosses intact; `checkDoneValue` folds byte-metering and number-losslessness into one walk that rejects an over-budget payload before the incremental work it would otherwise add — the enqueued children; strings and keys are metered by a non-allocating escaped-size scan (`jsonStringBytesUpTo`), so the escaped copy is never materialized. It does not re-bound the frame's own width: `done.value` is already `JSON.parse`'d when the check runs, so a consuming runtime must cap fd-3 bytes before parsing. Beyond-safe-range integral doubles serialize through `BigInt` digits so the exact integer crosses, not `String()`'s rounded form.
- **`logTruncationMarker`** produces the in-band marker text a log ledger emits when it exhausts its byte budget.

`py/protocol.py` mirrors the message shapes as `TypedDict`s and re-declares the two surfaces both sides EXECUTE against — `PROTOCOL_FD = 3` and `log_truncation_marker` — with byte-identical text.

The package ships the runtime alongside the protocol; it remains independently buildable. `check-workspace-constraints` reads every `packages/<group>/<pkg>/package.json` unconditionally, while the coverage and invariant-topology checks exercise the package as soon as its directory exists.

## Wire contract

Frames are JSON-lines on fd 3, one object per line, leaving stdout/stderr free for the program's own output. Child → host: `boot-ack`, `call`, `log`, `done`. Host → child: `boot` (first frame), `run` (after `boot-ack`), and one `reply` per `call`. The `log` frame's `truncated` flag marks the frame that IS the child ledger's own truncation marker, so the host stops capturing at the same point the child did instead of inferring it from its own budget. The `log` frame's `open` flag marks an unterminated line committed by an explicit flush: the host holds it and appends the next frame to the same entry, so an explicit flush followed by more text reads back as one line rather than a fake newline. The one exception is truncation: when a later over-budget frame trips the ledger, the already-billed prefix is committed as its own entry and the truncation marker follows it (marker last, no re-charge). The merged entry's wire cost is billed exactly once, split incrementally across its fragments on both sides (O(k) for k fragments, never a re-walk of the whole hold): the FIRST fragment pays the full JSON-string cost plus the separator, each continuation and the closing frame pay only their content; the host's exact-cost caps are `logBudget - 1` for a first fragment (the ledger's reserved byte, matching `admit`) and `logBudget + 2` for a continuation or closing frame (billed without the two quotes), and `jsonStringCostUpTo` returns `undefined` below a 2-byte cap; the child keys its split billing off `_open_started` alone, so a closing frame bills as the merged tail. `done.error.kind` is one of `exception`, `invalid-output`, `output-limit`; wall/CPU budgets, aborts, and substrate death are observed host-side, not carried as frames.

## Mirror alignment

`py/protocol.py` and `src/protocol.ts` agree that `LogMessage` carries `truncated`, `DoneMessage.error` carries `kind`, and `Namespace` may carry `errorClass`. `tests/protocol-mirror.e2e.ts` spawns a real `python3` and asserts `PROTOCOL_FD`, `log_truncation_marker`, and each `TypedDict`'s required and optional wire field sets against `src/protocol.ts`. A renamed or dropped field, or a required/optional mismatch, fails the test. Field *types* are not compared across the language boundary; review and the runtime's real-subprocess suite (`runtime.spec.ts`) own that gap.

## Alternatives considered

**Require a future Python JSON codec (`_encode_json_plain` / `_decode_json_plain`) to live in `py/protocol.py` for cross-side symmetry with `protocol.ts`.** Rejected. The repository's "prefer symmetry for parallel values" rule points at genuinely parallel values; these are not. The host-side codec in `protocol.ts` validates hostile input and is self-contained. A child-side codec would produce trusted output and belong with bootstrap-owned emission and cost accounting; forcing only its entry points into `protocol.py` would couple the vocabulary mirror to runtime internals or create an import cycle. `protocol.py` remains a pure wire-vocabulary mirror; the codec (`_encode_json_plain` / `_decode_json_plain`) lives in `bootstrap.py` with the runtime it serves.

**Keep the protocol files outside a buildable package until a runtime ships.** Rejected: the workspace-constraint, coverage, and invariant-topology checks require every directory under `packages/<group>/<pkg>` to be a buildable package, and the protocol has independent tests and a public wire vocabulary.

## Consequences

Bought: the fd-3 protocol and its hostile-input codec form a self-contained, fully unit-covered layer, with an executing guard against TypeScript/Python field-set drift. The runtime built on it (`bootstrap.py`) consumes the reviewed wire contract.

Cost: the package name denotes a Python runtime family and `src/index.ts` exports the full `PythonCodeRuntime` implementation, so the protocol vocabulary is only one part of the package surface. The mirror e2e compares field names and required/optional status across the two sides but not field types; comparing type declarations across TypeScript and Python has no mechanical equivalent, so review and the runtime's real-subprocess suite retain that responsibility.
