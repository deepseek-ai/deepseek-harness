# Agent Note: PTC Script evaluation and state retention

Status: implemented

English | [中文](2026-10-20-ptc-script-evaluation-and-retention.zh.md)

## Problem

Program syntax and memory lifetime answer different questions. A consumer may need Script declarations and completion values while requiring either a fresh environment or retained references. Inferring memory lifetime from REPL syntax prevents that choice.

## Decision

The Node provider adds `executionMode: vm-script` and a separate `scriptPersistence` option, defaulting to false. `PtcRuntime.programFormat` describes accepted syntax; `retainsState` describes owner-scoped memory. Consumers use the latter for persistence controls and guidance. Existing `per-call` and `persistent-in-memory` configurations retain their meanings and defaults.

This extends the mode-naming decision in [best-effort persistent PTC](2026-09-23-best-effort-persistent-ptc.md), whose ownership, non-durability and recovery decisions remain active. The Node provider selects its evaluator once and shares managed process mechanisms across temporary and retained lifetimes. AsyncFunction, REPL and Script remain separate evaluator implementations, so process reuse does not define syntax.

VM Script uses a separate realm inside the managed child process. Top-level await uses the Node.js v26.6.0 REPL transform, with Acorn and acorn-walk supplying parsing and traversal. Detection precedes native compilation because non-strict Script can compile `await` as an identifier. The adapted visitors traverse computed method keys without entering method bodies. The source retains upstream attribution and license; the [package reference](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#known-limitations-and-deferred-work) owns declaration and realm limitations.

## Alternatives considered

**Replace existing modes with Script.** This would change async-function return syntax and REPL declaration behavior for existing consumers. An additional mode preserves those choices while exposing Script semantics.

**Encode syntax and retention in every mode name.** Separate names for fresh and retained Script would repeat syntax choices and encourage consumers to infer persistence from the format. One Script mode and an explicit retention option keep each fact separately observable.

**Use native Script without await conversion.** Native Script cannot evaluate top-level await. Parsing only after native compilation fails also misses valid programs where `await` compiles as an identifier. The Node transform supplies retained declarations and completion handling while keeping its known semantic tradeoffs explicit.

**Own a generic AST walker.** A local walker duplicates traversal provided by acorn-walk and must independently track new Acorn nodes. The maintained walker removes that implementation; only the evaluation-specific visitors remain local.

## Consequences

Script state is best-effort process memory, with the same explicit owner release and sandbox invalidation rules as retained REPL execution. It is neither serialized nor reconstructed by rerunning earlier programs. An uncaught callback exception or unhandled rejection terminates the Script process; programs must await asynchronous work.

The published format union now includes `script`, and custom retained providers must report `retainsState`. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/ptc-script-format/guide.md) describes consumer migration. Source deployments need the evaluator modules and Acorn packages; private process bundles include those dependencies.
