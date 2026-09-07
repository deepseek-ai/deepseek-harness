# Agent Note: Keep supported-platform tests semantic

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-22-cross-platform-test-fixtures.zh.md)

## Problem

The unit and coverage suites run on Windows, macOS, and Linux, but a platform-neutral behavior can be hidden behind a platform-specific fixture. Literal POSIX paths become drive-relative paths on Windows, a hosted `file:` URI can be a valid UNC path there, and child-pipe closure or event-loop scheduling does not settle at the same point on every host. POSIX-only filesystem states such as FIFOs, executable mode bits, and directory search bits have no direct Windows fixture.

Treating fixture syntax as product behavior either reports false regressions or encourages production normalization that erases native path semantics.

## Decision

Tests of platform-neutral behavior construct absolute paths and `file:` URIs with the host's `node:path` and `node:url` APIs, then assert native absolute output or stable workspace-relative output as the contract requires. Invalid-URI fixtures use encodings rejected by `fileURLToPath()` on every supported platform.

Transport-failure tests inject the connection's message writer and deliver the same asynchronous write callback error that a real Node stream would report. The production writer still writes framed messages to child stdin. This keeps a real child alive while the test deterministically distinguishes transport failure from process exit without reaching into platform-specific pipe handles.

Language-server teardown targets the whole descendant tree through a negative process-group id on POSIX and synchronous `taskkill /T /F` on Windows. Windows suppresses only taskkill's already-absent-tree status; command, permission, and other tree-kill failures remain teardown failures. A read-only provider query retries once only when its selected pooled transport fails before or during that query; errors from a still-live server are not replayed. Terminal tests wait for their observable rendered output instead of assuming one event-loop turn is sufficient.

Tests for a genuinely POSIX-only primitive use a narrow Windows exclusion on that case. Adjacent cross-platform cases continue to pin non-regular file rejection, unavailable command rejection, and inaccessible working-directory rejection. Supported Windows paths remain inside the per-file coverage gate rather than being excluded with their test files.

## Alternatives considered

**Normalize all paths and URIs to POSIX strings.** This would make assertions uniform but would change correct Windows behavior: external paths are native absolute paths, UNC file URIs are valid, and configured homes resolve through the host path rules.

**Manipulate child-pipe internals until a write fails.** CRT descriptors and libuv handles have different ownership across hosts and Node versions, so this would test undocumented fixture machinery instead of the connection's write-failure contract.

**Skip whole files or packages on Windows.** Broad exclusions would hide supported behavior. Only the individual fixture whose state cannot exist on Windows is excluded; the surrounding contract remains covered.

## Consequences

Portable fixtures are slightly more explicit because expected paths derive from shared native constants and transport failures enter through a narrow writer hook. Platform-only exclusions require a neighboring cross-platform assertion for the product behavior they support. Windows teardown depends on the host `taskkill` command after graceful protocol shutdown has failed; a successful synchronous result keeps disposal bounded and makes descendant exit observable before cleanup returns, while a failed tree kill remains visible to the disposer.
