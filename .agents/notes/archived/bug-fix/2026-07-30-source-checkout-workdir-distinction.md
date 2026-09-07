# Agent Note: Source checkout paths do not define working directories

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-source-checkout-workdir-distinction.zh.md)

## Problem

The `harness:source` prompt section follows the [source-location decision](../../archived/feature/2026-07-21-dsh-system-prompt-source-path.md), but its original wording called the checkout “your own source code” without distinguishing that path from the session workspace. In a normal TUI configuration that does not state `{{cwd}}` in its persona, this may be the only fixed absolute path near the start of the system prompt. DeepSeek V4 could therefore answer “what's the workdir?” with the harness checkout instead of determining the session's current working directory.

A blanket statement that the checkout is not the working directory would also be false. `dsh meta` intentionally makes the source checkout both values.

## Decision

The section identifies the path as the “DeepSeek Harness implementation checkout.” It says that the checkout location and current working directory are separate values that may differ, forbids inferring the working directory from the checkout path, directs the model to use `pwd`, and limits the checkout's purpose to inspecting or extending DSH itself.

The path derivation and global `harness:source` ownership remain unchanged. The section uses first-party order −900, immediately after `harness:identity`. Describing the values as conceptually separate rather than always unequal keeps the instruction accurate in both ordinary project sessions and `dsh meta`.

## Verification

The `dsh-app-boot` unit test pins the exact text and its ordering. The CLI keyless PTY smoke inspects the assembled request header. The TUI `source-checkout-workdir` snapshot mounts the section with `/opt/dsh-source`, asks “what's the workdir?” through a recorded DeepSeek V4 turn, and requires the replayed transcript to run `pwd` and report the generated workspace rather than the checkout.

## Alternatives considered

**Say that the checkout is never the working directory.** Rejected because `dsh meta` deliberately makes them the same path.

**Put the current working directory in the global source section.** Rejected because the source section is launcher-global while the working directory belongs to each session; combining them would duplicate the loop's `cwd` ownership and make a stable source fact vary per agent.

**Remove the source path from the prompt.** Rejected because self-referential DSH tools still need a reliable checkout location when the launcher starts from an unrelated project.

## Consequences

The prompt is longer and a direct working-directory question may spend one inexpensive `pwd` tool call. In exchange, the model no longer treats the harness implementation path as an implicit task workspace, while meta mode remains truthful when both values coincide.
