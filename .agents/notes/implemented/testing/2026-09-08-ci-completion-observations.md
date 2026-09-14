# Agent Note: CI fixture completion and isolation

Status: implemented

English | [中文](2026-09-08-ci-completion-observations.zh.md)

## Problem

The reference CI run (run 34206953049) reports a webhook-created Session absent after a one-second poll and empty PowerShell output before a five-second read deadline. HTTP acceptance, projected UI state, process startup, and durable completion are separate observations. Tests need an explicit completion condition and controls that prevent an intermediate state from satisfying it. The [completion-wait decision](2026-09-08-ci-readiness-and-completion.md) owns those conditions and lane budgets; these fixtures make their ordering and cleanup observable under controlled delays.

## Decision

The [GitHub review browser test](../../../../apps/web/tests/github-ready-review.e2e.ts) holds real Workspace creation after HTTP 202, verifies that neither the Agent nor the model request exists, then releases creation and awaits the matching Session's `turn/end`. Cleanup releases the barrier, restores the method, and removes the event listener even when the test times out. Workspace membership, request counts, prompt content, and browser expectations retain their original assertions.

The [PowerShell executor tests](../../../../packages/shell/pwsh-local/tests/executor.spec.ts) hold startup and consuming reads at private file barriers. The test controls when later output becomes available; final stdin/environment output is read after `done`. Polling uses the active test budget, and every constructed Context is registered before plugin initialization. Teardown captures Contexts and directories before awaiting disposal and removes directories only after that disposal completes.

The [queued-image test](../../../../apps/web/tests/queue-image.e2e.ts) separately holds admission and attachment retrieval, then captures the admitted row's loaded thumbnail. Cleanup shares one promise, releases held requests, and drains their handlers before closing the browser.

The [Details Session-lifecycle test](../../../../apps/web/tests/details-session-lifecycle.e2e.ts) awaits the frame's captured animation promises after closed state appears, then checks the zero-width track. Cancelled transitions also reach that assertion; animation settlement cannot make a persistent nonzero track pass.

The [whole-queue steering test](../../../../apps/web/tests/steering.e2e.ts) waits for enabled steering actions and the composer's queue-steering hint. A model-stream barrier keeps the following question-composer takeover pending while the test observes steering. Teardown releases that barrier before browser closure.

The [workspace-management test](../../../../apps/web/tests/workspace-management.e2e.ts) waits for restored composer focus before the next directory-dialog gesture. Its archive case gives the known seed id an explicit user title through the Session controller, then uses that exact title to identify the row across reload. An unrelated restored row cannot satisfy that locator; the durable archive assertion still checks the seed id and retained log.

The [Node runtime tests](../../../../packages/ptc-runtime/ptc-runtime-node/tests/runtime.spec.ts) exercise real managed-process execution, binding transport, elapsed deadlines and cancellation. The [sandboxed Node decision](../architecture/2026-09-11-sandboxed-node-ptc-runtime.md) supersedes the worker ELU budget and its controlled-sample tests; real process and transport evidence remains necessary.

The [detached-launch tests](../../../../packages/host/open-in-app/tests/launch-detached.spec.ts) control watch time and deliver late process events through the real launcher's registered callbacks. They check one settlement, one unref, and no child kill. Real-process environment and early-exit cases remain in the [resolver tests](../../../../packages/host/open-in-app/tests/resolver.spec.ts).

The [LSP backpressure test](../../../../packages/lsp/lsp-stdio/tests/instance.spec.ts) preserves the real paused-reader fixture and large native pipe write. Before accepting the abort error, it verifies that the pending write callback settled and the captured subprocess completed; `instance.dead` alone can be true as soon as disposal starts.

### Built-client import classification

The [Node import sweep](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts) admits the Dockkit bundle only when Node reports `ERR_UNKNOWN_FILE_EXTENSION` for a `.css` file, and fails every other error and every unexpectedly successful exempt import; the [stylesheet exemption decision](../bug-fix/2026-09-10-built-bundle-css-exemption.md) owns which stylesheets that covers. Scoped resolve/load hooks exercise expected CSS failure, another stylesheet, another extension, arbitrary failure, another error code, and stale exemption without modifying shared build artifacts.

## Alternatives considered

**Production timeouts, retries, or suite serialization.** Rejected because none establishes the missing completion observation.

**Completion inferred from acceptance or a preview.** HTTP 202 and an optimistic image can precede the operation being asserted.

**Controlled samples replacing real execution.** Rejected because timer samples alone cannot verify process launch, control transport or managed cleanup.

## Consequences

Each fixture owns its clocks, barriers, callbacks, processes, and temporary paths. Controlled observations supplement real worker, subprocess, browser, and persistence paths. Product behavior, production timing, benchmark budgets, CI scheduling, and recorded expectations remain unchanged.
