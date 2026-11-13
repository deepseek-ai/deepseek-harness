# Agent Note: PTC output truncation without execution cancellation

Status: implemented

English | [中文](2026-11-13-ptc-output-truncation.zh.md)

## Problem

Stopping a program because its logs exceed the output budget can interrupt a sequence of external actions. Earlier effects remain, but the caller cannot tell which later actions ran. Repeating the program to obtain less output can repeat those effects. A full log budget can also hide a subsequent exception by replacing its kind with an output-limit failure.

## Decision

Captured output has bounded retention. Exhaustion preserves an ordered prefix, discards subsequent output and sets `outputTruncated`; it does not cancel execution or discard retained variables. Existing deadlines, cancellation, heap limits and control-message limits still apply. Finalization prioritizes the required completion value or bounded failure diagnostic within the combined payload budget. Truncated diagnostics preserve their failure kind. Required completion values remain lossless and fail if they cannot fit.

This supersedes only captured-output termination and diagnostic reclassification in [typed tool returns](../feature/2026-07-20-ptc-typed-tool-returns.md), and overflow-driven state disposal in [retained PTC](2026-09-23-best-effort-persistent-ptc.md). Those records still own lossless values and retained-state lifetime; [explicit output](2026-11-09-explicit-ptc-output.md) still owns inspection and image projection.

## Alternatives considered

**Terminate on output exhaustion.** It limits output production earlier, but turns a presentation limit into interrupted external work without rollback.

**Return success with a truncated completion value.** It violates the caller's requirement for complete JSON data. Only captured output and diagnostic text may be shortened.

## Consequences

Successful truncated runs remain successful tool results. Callers inspect current state for missing information instead of replaying completed actions. Output suppression does not bound allocations in argument evaluation or native code; existing resource controls retain that responsibility. Tests cover subsequent actions, retained variables, initialization, ordered images, byte limits and later exceptions, deadlines and cancellation.
