# Agent Note: User-terminal permissions

Status: implemented

English | [中文](2026-09-16-user-terminal-permissions.zh.md)

## Problem

Users need to run commands themselves while keeping the Agent restricted. Sharing the Agent's sandbox mode forces a user to widen Agent access for manual work, and retaining an interactive shell prevents later mode changes because its process confinement cannot follow a new Session setting.

## Decision

The Web sidebar terminal runs directly through the Session's subprocess provider with the execution environment's system-user permissions. It neither confines the shell through the Agent sandbox nor requests Agent approval. Operating-system permissions, container isolation and the provider's credential-environment scrubbing continue to apply. Session identity owns access, process cleanup and the initial directory; sandbox policy supplies only the configured directory fallback when the Session has no cwd.

Agent permission changes leave user terminals running. Agent-owned shell and terminal tools retain their own sandbox enforcement. User terminal input and output create no model input or Session events.

This decision supersedes only the shared sandbox policy and mode-switch restriction in the [Web sidebar terminal decision](../feature/2026-09-09-web-sidebar-terminal.md). That note remains active for process ownership, transport, screen recovery and shell selection. OpenCode's `packages/core/src/pty.ts` and `packages/core/src/pty/pty.node.ts` provide adjacent evidence: its interactive terminal creates a PTY directly with the selected shell and working directory.

## Alternatives considered

**Inherit Agent permissions.** One Session mode describes both processes, but users must also grant the Agent access needed only for manual commands. Persistent user shells then obstruct changes to Agent permissions.

**Add a separate terminal permission selector.** The product treats this terminal as a user-operated system shell. Another selector adds policy state and process-restart semantics without a current requirement; deployment and operating-system controls already determine the execution environment.

## Consequences

Access to the Web terminal grants command execution as the subprocess provider's system user, including writes outside the Session workspace where that user has permission. It does not grant root or escape a container. Session ownership remains useful for grouping and cleanup without implying Agent authority over user actions.

Controller tests pin direct shell launch across all Agent sandbox modes and continued ownership during mode changes. The recorded Web permission-policy scenario keeps one real user PTY open across read-only, full-access and workspace-write transitions, verifies writes inside and outside the workspace, and retains the Agent's read-only denial and approval assertions. The Bash browser assertions run on macOS and Linux; Windows retains the portable controller checks and Agent-policy replay.
