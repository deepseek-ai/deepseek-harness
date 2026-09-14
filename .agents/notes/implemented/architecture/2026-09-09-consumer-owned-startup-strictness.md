# Agent Note: Consumer-owned startup strictness

Status: implemented

English | [中文](2026-09-09-consumer-owned-startup-strictness.zh.md)

## Problem

Best-effort Loader reconciliation preserves usable plugins, but applications still need a minimum set of capabilities. An HTTP application without its listening server is not running, while an unavailable tool can be omitted without making the remaining application unusable. Cordis cannot infer this distinction from plugin implementation or dependency state.

## Decision

DSH owns startup strictness outside vendored Cordis. App-boot audits the settled initial tree against one global list of stable entry ids. A listed entry that is present, enabled, and not active rejects startup and disposes the application. A listed id that is absent or disabled has no effect. The bootstrap Include is required by entry identity because a missing or invalid root configuration prevents application assembly. Other inactive entries produce one warning and leave successful siblings running.

The required ids are `agent-loop`, `webserver`, `modules`, `connection`, `headless-runner`, `acp`, and `sdk-jsonrpc-server`. They represent shared Agent execution, application endpoints, and Web bootstrap/transport. Web needs its client module registry and authenticated connection even when the HTTP server can listen without them. Providers already required through injection need no separate entry: their absence leaves a listed consumer pending or failed.

The audit treats a throwing `disabled` expression as an entry failure, not a disabled entry, because evaluation never established whether to skip it. The same optional/required policy applies to that failure.

The audit runs only during initial application boot. Later config HMR remains best effort and keeps the failed candidate visible for repair.

This policy governs [Web host boot](2026-07-24-web-config-tree-boot-and-transport-layering.md), including its [client plugin roster](2026-07-23-client-plugin-loading-model.md). [Per-session presets](2026-08-03-per-session-agent-presets.md) own a separate strict subtree audit.

## Alternatives considered

- **Add transactional and best-effort modes to vendored Loader.** Rejected because strictness belongs to the application or resource owner, while a Loader group contains unrelated plugins. A mode would also expand the vendor patch and leave callers to select a policy at every group.
- **Declare required entries in each profile.** Rejected because the same application endpoints would be duplicated across profile data and custom profiles. A global list treats missing ids as irrelevant while keeping stable shipped ids authoritative.
- **Make every startup failure optional.** Rejected because a process that cannot expose its selected application endpoint must report launch failure.

## Consequences

Stable required entry ids are part of application assembly. Renaming one requires updating the list and its tests. Optional plugin failures remain visible in Loader state and stderr without tearing down active siblings. Required failures use the same detailed import, activation, or pending-service diagnostic before app-boot disposes the root.

## Testing

App-boot unit tests cover absent and disabled required ids, optional import failure, config evaluation failure, synchronous and asynchronous `apply()` failure, pending dependencies, and required failure teardown. The built Web-profile acceptance serves the full UI with optional failures and exits nonzero without readiness when the required HTTP port is occupied or `modules` or `connection` cannot activate.

The [Web process matrix](../../../../apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts) independently exercises optional and required failures at startup and after native patch-file edits. Authenticated HTTP requests and plugin lifecycle files distinguish a usable application from a surviving process. These keyless process checks complement the [controlled-delivery unit tests](../testing/2026-09-09-user-patch-hmr-test-delivery.md): unit tests isolate reconciliation failures, while the process tests also require the shipped launcher, native watcher, and bounded shutdown to work together.

The matrix enables Chokidar's `awaitWriteFinish` to acknowledge stable file contents before each reload; otherwise its short change-event suppression window can discard the next test edit. Native events remain required, and assertions wait for observed activation or failure rather than a fixed settling sleep. This is explicit test configuration, not evidence for the default watcher timing.
