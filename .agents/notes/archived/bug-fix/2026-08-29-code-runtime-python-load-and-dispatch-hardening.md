# Agent Note: Load-time pythonBin validation, binding snapshot, and reply-drain settle in the CPython backend

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-29-code-runtime-python-load-and-dispatch-hardening.zh.md)

## Problem

Review of the CPython subprocess backend (packages/experimental/code-runtime-python) surfaced four non-blocking findings that a long-running host could still misbehave under: an explicit `pythonBin` path bypassed the load-time configuration checks, a throwing binding member accessor could escape the fd-3 data callback and terminate the host, the reply drain could hang forever waiting for a `drain` event that a destroyed pipe never emits, and two leak assertions diffed a global tmpdir in a way a parallel vitest worker could false-positive on.

## Decision

### An explicit pythonBin must be an executable regular file at load

`resolvePythonBin` returned an absolute or slash-containing `pythonBin` verbatim, so a missing, non-executable, or directory path passed the constructor's load checks (which only rejected empty/NUL values and unresolvable basenames) and surfaced only at the first `run()` as a misleading `worker-exit`. The explicit-path branch now validates with the same `accessSync(X_OK)` + `statSync().isFile()` checks the PATH branch uses (a directory passes `X_OK`, so the regular-file requirement is the deciding half), resolving relative explicit paths against the host CWD first — the same place `spawn` would have looked. A failing explicit path makes `resolvePythonBin` return `undefined`, and the load check now distinguishes the two failure classes in its message: `is not an executable regular file` for an explicit path, `does not resolve on PATH` for a basename.

### Binding callables are snapshotted during validation

`namespace.functions` is caller-supplied, so its members may be exposed through getters or a Proxy. Reading one of them inside the fd-3 `data` callback — `record[message.name]` — threw OUTSIDE the dispatcher's try and terminated the host (an `uncaughtException` handler, if installed, would only let the run degrade to the wall clock). `validateBindings` now reads every member into a plain own-property record during run()'s synchronous validation segment, so a throwing accessor becomes the seam-misuse rejection run() already reserves for malformed bindings. The snapshot is also the single key set the boot frame advertises AND dispatch reads, so a getter whose keys differ between reads cannot desynchronize the child's allowed names from what the host will actually call. The record is null-prototype (`Object.create(null)`): the seam contract treats member names like `__proto__` or `constructor` as ordinary own properties, and a plain `{}` assignment of `__proto__` hits the prototype setter instead of creating the own property, dropping the name from the boot frame and making a call to it fail with `KeyError`.

### The reply drain settles on a destroyed pipe

`drainReplies` awaited `once(proto, 'drain')` after a full-buffer write; a pipe destroyed under the wait (child exited, close-deadline teardown) never emits `drain` again, and `events.once` rejects only on `error`, not on `close` — the await could hang forever, leaving `draining` true and the unconsumed queue (and any wide payloads it still holds) pinned with the closure. The wait now listens for `drain`, `close`, and `error` together, removing all three listeners whichever wins, and the drain loop short-circuits on `proto.destroyed` before the next write, so the `finally` clears the queue and resets `draining`.

## Testing

- `tests/runtime.spec.ts` — the load-rejection cases cover a missing absolute path, a non-executable regular file, a directory, and a slash-containing relative path, each asserting the `is not an executable regular file` message; a positive case keeps an absolute interpreter path loading and running. A case with a getter that throws on read asserts `run()` rejects as seam misuse; a companion with a counting getter asserts the accessor is read exactly once (the snapshot), proving dispatch and the boot frame share the snapshot. The spawn-failure case now stages an executable wrapper, loads the runtime, deletes the wrapper, and asserts the run still resolves `worker-exit` (a load-time-valid path can still fail at run time; the old fixture used a path that is now rejected at load).
- `tests/boot-write-failure.spec.ts` — a fake child backpressures every fd-3 write and destroys the pipe while the host waits for `drain`; the run settles on the wall clock instead of hanging on the drain wait.
- The two staging-leak cases assert the exact paths this test file staged (recorded by the mocked `mkdtempSync`) are gone, instead of diffing a global tmpdir that a sibling worker could perturb.

## Alternatives considered

**Leave the explicit-path branch unvalidated and let the first run() report it.** Rejected: a missing, non-executable, or directory interpreter path is a self-contained configuration error that the caller can fix without running a program, and the empty/NUL and basename checks already set the precedent that these fail at load. The run-time `worker-exit` it produced was also indistinguishable from a substrate failure, so the caller could not tell a configuration mistake from an environment problem.

**Guard the member access inside the dispatch path instead of snapshotting.** Rejected: a try around `record[message.name]` would still read the getter on EVERY call, repeating its side effects and allowing its key set to differ between the boot frame's advertisement and dispatch. Snapshotting once, during validation, converts the throw into the seam-misuse rejection run() already reserves and fixes the key set to one record.

**Extend the drain wait with a timeout.** Rejected: a timeout would settle the wait while the pipe might still be alive, dropping a queued reply that a still-open pipe could have taken. Listening for `close`/`error` settles exactly when the pipe is gone, which is the only case where `drain` can never arrive.

## Consequences

Load now rejects a self-contained configuration error earlier (an explicit interpreter path that is not an executable regular file), matching the basename treatment. Binding member accessors are read once, at validation, so a getter's side effects cannot repeat per call. A destroyed fd-3 pipe no longer strands the reply drain. The leak assertions are immune to concurrent staging by sibling workers.
