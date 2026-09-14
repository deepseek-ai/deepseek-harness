# Agent Note: Computer-use provider registration

Status: implemented

English | [中文](2026-09-12-computer-use-provider-registration.zh.md)

## Problem

Desktop providers expose different operations, observation formats, and platform facilities. DSH needs to prevent accidentally enabling two providers in one composition while allowing provider-specific integrations to work without committing to a common action API.

## Decision

The DSH capability is named **computer use**. [`dsh-computer-use`](../../../../packages/computer-use/computer-use/README.md) owns `ctx.computerUse`, which registers one provider-owned name and returns its effect disposer. A second registration fails regardless of its name. The service contains no provider object, shared operation type, dispatch method, Session lock, or runtime selector.

**Cua Driver** names the upstream implementation. The [MCP provider](../../../../packages/experimental/computer-use-cua-driver-mcp/README.md) connects an installed executable. The [native provider](../../../../packages/experimental/computer-use-cua-driver-native/README.md) installs the upstream native npm dependency. Both remain experimental and join the explicit public-release allowlist; neither is enabled by default.

Each integration exposes the upstream tool catalog. MCP result conversion stays in `dsh-mcp-client`, whose callback-based tool adapter also converts native Cua Driver results. The computer-use service has no dependency on that adapter or either provider.

Provider teardown retains the registration until tool admission stops and owned work and resources close. A grouped Cordis effect orders that cleanup; separate effects may dispose concurrently. The native provider uses `tools/execute` to share cancellation across native calls and screenshot admission while preserving execution identity. Concurrent Sessions remain caller-coordinated because a provider registration does not own an observe, act, and verify workflow.

## Alternatives considered

**Unified action API.** A common screenshot, input, and window vocabulary would require translating provider-specific semantics without a current consumer that needs portability. Provider-owned tools preserve those semantics.

**Only external MCP.** This reuses an installed driver and its process identity but leaves a separate installation prerequisite. The native provider supplies a one-package runtime installation.

**Only embedded native runtime.** Native integration makes DSH own runtime lifecycle and shares native failures with its backend process. The MCP provider remains available for independently installed drivers.

**Session ownership broker.** Reserving a desktop across a whole workflow requires an explicit acquisition and release policy. The current service enforces provider registration only, leaving workflow coordination to callers.

## Consequences

The service remains independent of experimental packages. The public-release allowlist admits the two provider packages without promoting their support status. Configuration selects a provider, and switching requires unloading the current provider first.

Native platform support and host permissions remain upstream and deployment responsibilities. macOS cursor-overlay hosting and dedicated Desktop permission UI are deferred. Cancellation stops waiting and propagates to the driver; it does not promise rollback of delivered desktop input.
