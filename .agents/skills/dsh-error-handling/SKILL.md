---
name: dsh-error-handling
description: Apply error-handling principles when designing or reviewing failures, error classes and codes, tool failures, recovery, retries, background tasks, and user-visible error reports.
---

# DeepSeek Harness Error Handling

Define failures, their owners, and what remains safe after failure.

## Typed, structured failures

Expected failures need declared types, stable discriminants, and handling-relevant details. Reuse package error conventions, preserve causes, and separate machine identity from display text. Never route handling by parsing messages. Unexpected defects such as `assertNever` may remain plain `Error`; containment must never turn them into success.

An error class that carries a machine code extends `HarnessError` from `dsh-error` (also re-exported by `dsh-llm`), directly or through its package's error class, never bare `Error`. Prefer one error class per owning package or domain over a class per failure; a separate class is justified when callers catch it by type or it carries its own structured fields, such as `ToolArgsError.violations`. `name` is the class name, except for cancellation (below), and `code` values are stable `UPPER_SNAKE_CASE` strings, usually prefixed by the domain and declared as a union or constants beside the class. A code names the failure class its consumers act on, not the call site; add a code rather than reuse one whose meaning differs. The [error class and code guide](references/error-codes.md) defines class choice, naming, the standard conditions, declaration, foreign-error conversion, and compatibility.

Convert foreign failures where the dependency is owned. Node errno, SDK, protocol, native, worker, and cross-realm errors become the owning package's error with the original as `cause`; a foreign numeric or vendor code belongs in the message, not in `code`. Preserve structure across layers: never re-wrap a `HarnessError` in a plain `Error`, store only its message for a later rethrow, or drop its `name` and `code` while redacting text. A process or worker boundary transports `name` and `code` and reconstructs the error.

## Tool failures

The tool registry keeps `error.name` and `error.code` on `tool/result` when the producer supplies them: a `HarnessError` thrown by the tool body, a pre-execute `deny`, guard denial, or post-execute block with `info` (including the registry's approval denials, `ApprovalError` with `APPROVAL_REJECTED`, `APPROVAL_CANCELLED`, or `APPROVAL_UNAVAILABLE`), the registry's own cancellation result (`AbortError` with `ABORTED` or `ABORTED_BEFORE_DISPATCH`, also applied to a signal reason or an `Error` named `AbortError` that the body or a `tools/execute` wrapper throws after cancellation), or a `tools/execute` wrapper result such as the timeout policy's `TOOL_TIMEOUT`. Any other thrown value, and a guard denial or block without `info`, persist only text that retry policy, UI, and analytics cannot route on. Every expected failure reachable from a tool body therefore throws a `HarnessError`, normally the owning domain's subclass:

- Hand-checked argument constraints throw `ToolArgsError` (`INVALID_ARGS`) from `dsh-tools`.
- Missing composition or caller context, such as an absent Agent, service, or open turn, throws `ToolContextUnavailableError` (`TOOL_CONTEXT_UNAVAILABLE`) from `dsh-tools`.
- Caller cancellation either propagates the signal's reason or an `Error` named `AbortError`, which the registry classifies as `AbortError` with the `dsh-tools` `TOOL_ABORTED` constant (`ABORTED`), or throws a `HarnessError` with that `name` and code. Never replace it with a different plain `Error`; a failure distinct from the cancellation, such as a cleanup failure, keeps its own class and code.
- Dependency failures follow the conversion rule above; filesystem errno maps to `FsError` codes such as `FS_NOT_FOUND`, `FS_PERMISSION_DENIED`, and `FS_IO_ERROR`.

A policy that denies a call in `tools/pre-execute`, through `tools.guard()`, or by a post-execute block supplies `info` with its own `name` and `code`. A failure the model must not treat as success is an `isError` result; a successful domain outcome in a non-ideal state, such as a non-zero exit or no matches, stays a success value, and a success-shaped failure value is allowed only when the output schema documents it. Tests assert `error.info.name` and `error.info.code` for each expected failure path, not only the message.

Existing `name` and `code` values persist in Session logs and feed analytics. Renaming or reclassifying one is an externally perceptible change that needs an [upgrade guide](../dsh-create-upgrade-guide/SKILL.md).

## Catch, recover, or stop

For each failure, define handling and reporting owners, containment, and guarantees in the owning API documentation: valid invariants, absent/partial/committed/unknown effects, and cleanup responsibility. Background work retains these obligations.

Catching limits exception propagation, not mutations. Only the affected state's owner can establish safe continuation. Otherwise stop dependent work, discard invalid state or instances, or escalate. Logging alone is not recovery. Retries require safe repetition, cancellation, and an explicit owner; finite operations need budgets, while continuing supervision needs lifecycle ownership and observable degradation.

### Empty catch clauses

An empty `catch` has no statement other than `;` in its block, and it discards every failure its `try` raises. Use one only when every such failure leaves the owner's state valid and no caller could act on it, such as failing to remove a temporary file that nothing reads. A `catch` that logs, reports, rethrows, or returns a fallback is not empty, and the rules below do not apply to it. [`verify-empty-catch`](../../../scripts/verify-empty-catch.ts) checks every `try`/`catch` statement in first-party JavaScript and TypeScript, including tests; it does not check `promise.catch()` callbacks. The checker checks the form; review checks that the name and the reason are true.

**The `try` holds one statement.** One statement means one syntactic statement, such as one call or one assignment, however many lines it spans; it does not mean one line. With several statements, the reason covers one expected failure while the clause also discards the others, including defects such as a `TypeError`, and a failure in an early statement skips the later ones while the caller sees success:

```ts
// Rejected: three statements in one try.
try {
  await unlink(tempFile)
  registry.delete(id)
  emit('removed', id)
} catch (_cleanupFailed) {
  // A leftover temporary file holds no state anything reads.
}

// Accepted: only the unlink failure is discarded.
try {
  await unlink(tempFile)
} catch (_cleanupFailed) {
  // A leftover temporary file holds no state anything reads.
}
registry.delete(id)
emit('removed', id)
```

When several statements each tolerate a failure, give each its own `try` and reason. The checker counts one block or one compound statement, such as one `if`, as one statement; review rejects such a `try` when it contains several operations.

**The binding names the expected failure.** Write `catch (_cleanupFailed)`, not `catch {}` or `catch (_)`. Lint requires an unused binding to start with `_`, and a bare `_` names nothing.

**A comment states why discarding the failure is safe.** Put it in the `catch` block or after the clause's closing `}` on the same line. A comment inside the `try` block or above `try` does not count. `// ignore` and `// expected` restate the empty block; say which failure is expected and why the state stays valid.

**Accept only some failures by testing them.** When only some failures are safe, such as a missing file while a permission error must still surface, write a non-empty `catch` that tests `code` or `name` and rethrows the rest; the checker does not check such a clause.

```ts
try {
  await unlink(tempFile)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
```

## Localized, actionable, visible reports

Every final report needs a readable summary, affected operation, and safe next action. Localize through the receiving application's locale mechanism where one exists; other diagnostics use their existing output language. Keep sensitive internal details out of user-facing text.

Untrusted state or unknown outcomes must be visible through UI or default-enabled, accessible logs: report the impact, uncertainty, system disposition, and safe next step. Persistent invalid state needs persistent visibility. Never claim success, rollback, or safe retry without guarantees. Reporting failures need an independent fallback.

Verify resulting state and visible outcomes, not merely that an exception was caught.

## Foundations

Meyer's *Object-Oriented Software Construction* (1997): contracts and invariants; Sutter's *Exceptional C++* (1999): exception safety guarantees; Armstrong's [thesis](https://www.erlang.org/download/armstrong_thesis_2003.pdf) (2003): isolation and supervision.
