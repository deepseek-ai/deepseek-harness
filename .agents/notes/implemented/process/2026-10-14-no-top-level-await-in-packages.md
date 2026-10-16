# Agent Note: Package sources must not use top-level await

Status: implemented

English | [中文](2026-10-14-no-top-level-await-in-packages.zh.md)

## Problem

The child-process entry `src/worker.ts` of [speech-to-text-sensevoice](../../../../packages/experimental/speech-to-text-sensevoice/README.md) ran `await startRecognitionServer(...)` at module scope. Top-level await makes module evaluation asynchronous: an importer's evaluation waits on it, and an entry failure becomes a module-loading failure instead of an error the entry handles explicitly. The same file is also the package's `./worker` export, and the browser Preview's module loader wraps module bodies as CommonJS, so it refuses to pack top-level await, which kept voice-input-bundle out of the image. No repository gate prevented this pattern; a repository-wide scan found two more cases outside bins: ssh's `src/helper-entry.ts` (the target of the `./helper` export) and inspector's `src/worker/entry.ts` (a worker_threads entry).

## Decision

- Entry modules use an explicit `async function main()`:
  - sensevoice: a failure before readiness writes only the error message to stderr and exits with code 1 once the message is flushed (`process.exit(1)` in the write callback, because a loaded native recognizer would otherwise keep the process alive); stdout carries only one `{"port":N}` line, which the Host parses as readiness.
  - ssh helper: `main()` holds the helper's try/catch/finally and signal handling; every failure is reported on stderr with the `dsh-ssh-sandbox:` prefix and exit code 127.
  - inspector worker: the synchronous startup stays at module scope, the asynchronous part runs in `main()`, and a failure sends the failure frame before stopping.
- Gate [verify-no-top-level-await](../../../../scripts/verify-no-top-level-await.ts):
  - **Scope**: `.ts` and `.tsx` files under `packages/*/*/src/**`.
  - **Rule**: based on the TypeScript AST. An `await` expression, `for await`, or `await using` whose nearest function body is the module is a violation, including occurrences in top-level if statements, blocks, try statements, loops, switch statements, conditional expressions, export initializers, and computed member names. Occurrences in functions, methods, constructors, accessors, parameter defaults, and class static blocks are not violations.
  - **Exclusions**: only bins are excluded, judged from declarations and syntax alone: the source file starts with `#!`, or it is the `src/<path>.ts|.tsx` that corresponds to a `lib/<path>.js` named by package.json `bin`. A process executes a bin directly, and no other module imports it. The current exclusions are the `src/bin.ts` files of webworker-packer and llm-mock-server, and a spec pins the list.
  - **Corpus guard**: the gate fails when the corpus is empty, contains no `.tsx`, or completely omits a `src/` directory that contains TS.
  - **Registration**: a shared hygiene gate in `run-gates`, running in the static lane and the hygiene aggregate. The rule text lives in the [package-surface defensive patterns](../../../../docs/defensive-patterns/package-surface.md).

## Alternatives considered

**Rely only on the webworker packer's refusal.** The packer checks only modules that enter the image, so packages outside the image could still introduce top-level await.

**Implement it as a lint rule.** oxlint has no existing rule that expresses "module scope" precisely. A syntax-level script gate is more controllable, and tests can pin every included and excluded form.

**Forbid it in bins too.** A process executes a bin directly and nothing imports it, so its top-level await does not affect loading any module.

## Consequences

Every importable package source evaluates synchronously, including packages that never enter the Preview image, and each entry handles its own startup failure; voice-input-bundle enters the Preview image.

The trade-off costs:

- Third-party packages and `apps/` are outside the scope; the page bootstrap script `apps/web/src/preview.ts` uses top-level await.
- sensevoice startup failure diagnostics carry only the error message, without a stack trace.

## Testing

- [verify-no-top-level-await.spec.ts](../../../../scripts/verify-no-top-level-await.spec.ts) pins every included and excluded form, the corpus guards, and the current exclusion list; [run-gates.spec.ts](../../../../scripts/run-gates.spec.ts) pins the gate's registration. With the asynchronous startup of the three entries above at module scope, the gate reports 4 cases (1 in sensevoice, 1 in ssh, 2 in inspector) and fails.
- [worker-entry.spec.ts](../../../../packages/experimental/speech-to-text-sensevoice/tests/worker-entry.spec.ts) launches the sensevoice entry and pins that a failure before readiness exits with code 1, leaves stdout empty, and reports the reason on stderr without a stack trace.
- [helper-boundaries.spec.ts](../../../../packages/ssh/ssh/tests/helper-boundaries.spec.ts) launches the ssh helper entry, and [integration.host.spec.ts](../../../../packages/experimental/inspector/tests/integration.host.spec.ts) starts the inspector Worker through `startInspector`; no spec drives the inspector worker entry's startup-failure frame.
