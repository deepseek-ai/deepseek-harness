# Agent Note: Session working directory

Status: implemented

English | [中文](2026-09-13-session-working-directory.zh.md)

## Problem

A fixed Session creation directory cannot represent a task that changes checkout during its conversation. Independent tools resolving paths from different sources can read and write different projects, while changing the process directory also affects unrelated Sessions. Putting mutable directory information in the system prompt changes the reusable prompt prefix.

## Decision

`dsh-working-directory` owns one logged effective directory per Session. Its projection initializes from the immutable original project and folds `working-directory/change`; consumers read that owner instead of deriving execution paths from the header or sandbox root. Directory changes validate through the filesystem provider, serialize within the Session, and publish only after the new directory is available.

The `dsh-base` composition mounts `working_directory({ cd? })` globally. The tool reads or changes the Session directory, so every Agent preset can select or recover it, including presets without file-editing tools. The Web composition keeps action tools in preset scopes.

Required user-context snapshots carry the current value; each committed change attempts to queue a notice through the ordinary Agent inbox. Cancellation or disposal may discard unadmitted notices while the directory event survives for subsequent requests. The original project is the recovery destination when the selected directory disappears. Missing recovery destinations produce an error. Write permissions remain independent.

Subagents capture the parent's current directory or an explicit override and commit their selected directory after inherited history. Existing processes, terminals, and persistent shells keep their process-local directory. Project instructions, skills, and completion follow the effective directory without changing Session identity, grouping, or runtime composition.

Live Session skill catalogs and file completion validate through the same directory owner. These reads can commit recovery and queue its notice before discovery, keeping discovered files and subsequent operations tied to the committed Session directory. Cold skill catalogs read the recorded projection without activating an Agent.

Web sidebar terminal environment lookup reads the effective directory without filesystem validation or recovery, so a missing directory does not prevent reconnecting to a retained terminal. New terminal creation validates and recovers through the directory owner before spawning; the process keeps that directory independently of later Session changes.

Playwright MCP and Chrome DevTools MCP validate the effective directory when acquiring a Session's MCP connection and use it to launch the server. Later directory changes do not restart the retained server or change its process directory.

File links and command directory labels use result metadata captured when each operation runs, so historical rows remain correct after later directory changes.

The [prompt-variables note](2026-07-05-prompt-variables-and-tool-guidance-ownership.md) retains strict interpolation, route-variable ownership, and tool-guidance ownership. The [environment-suffix note](../../archived/bug-fix/2026-09-06-environment-prompt-suffix.md) retains ordered prefix/suffix placement for deployment, Harness source, and Web guidance. This decision owns directory state and placement in user context.

## Alternatives considered

**Rewrite the Session header.** The header is immutable identity metadata used by storage, grouping, and permission roots. Rewriting it would conflate current execution state with the original project.

**Let worktree tools own directory state.** Ordinary directory changes, filesystem tools, and subagents need the same value. A Git-specific owner would duplicate selection and recovery.

**Change the process directory or synchronize every shell.** Concurrent Sessions and existing subprocesses have independent lifetimes. A Session change affects new directory-based operations, while a shell's `cd` remains local.

**Keep directory text in the system prompt.** Mutable operational context belongs after retained history, using the same user-context mechanism as permission state.

## Consequences

The runtime exposes one directory owner and preserves the original project. Consumers migrate together, including filesystem, shell, instructions, skills, subagents, and both SDKs. Directory existence can change outside the harness, so validation and logged recovery occur at use. Required runtime context remains visible even when optional context is suppressed.

`{{cwd}}` has no loop-provided value; custom personas that depend on that built-in fail strict interpolation. Deployments remove those references using the [system-prompt migration guidance](../../../../packages/core/system-prompt/README.md). When both the current directory and its recovery destination are unavailable, prompt assembly rejects model turns; the [directory service recovery guidance](../../../../packages/session/working-directory/README.md#known-limitations-and-deferred-work) requires restoring the directory or selecting an existing absolute directory through the SDK or host service.

Verification covers independent Sessions, relative changes, replay, cancellation, recovery, tool disposal, user-context rendering, provider inheritance, and real directory-based operations.
