# Agent Note: Separate background Shell command display from job state

Status: implemented

English | [中文](2026-10-10-background-shell-command-display.zh.md)

## Problem

An explicit background Shell call already carries its complete command and working directory at Start, but the Tool card shows generic argument JSON rather than the ordinary Shell command area. The original call returns a launch acknowledgement; the background result arrives through a separate completion notice or `job_output` call. Those messages do not directly carry the original Bash callId, so the acknowledgement cannot establish execution completion, and the original call's state cannot represent the job's live state.

## Decision

Valid explicit background `bash`/`pwsh` calls reuse the existing terminal command presentation. Before Start returns, the card indicates only that the launch call is in progress. After a normal launch acknowledgement, the same Tool card retains its command, working directory, wrapping, and disclosure state, and becomes a static command-only display without a run-state dot, exit code, empty-output placeholder, or continuing running animation. Launch failures retain the existing raw-argument and error-result presentation; Inspect still exposes the complete arguments and launch acknowledgement.

The terminal component receives the original call's `background` flag from Start and combines it with the call's `running` value: `background=true` and `running=true` mean that the launch call is still in progress. When the acknowledgement arrives, `background` stays unchanged and `running=false` leaves a static command; it does not describe the background job's running state. This introduces no derived presentation parameter or job state, and does not keep `running=true` indefinitely to pretend that the command is still executing. Ordinary foreground calls, persistent Shell calls, and `terminal_send` retain their default behavior; the existing Copy button's output-copy semantics do not change.

This decision covers explicit background launches only, not timeout promotion. It adds no job subscription, polling, output assembly, or callId/jobId index. Later completion notices and `job_output` keep their independent presentation, while the header's job panel owns live job information. The Tool card does not receive the final output, and Host interfaces, execution, and the Session log remain unchanged.

The [Client tool-presentation decision](../architecture/2026-08-23-client-derived-tool-presentation.md#terminal-card) still governs raw-event derivation and business ownership. This note supersedes only its generic-body rule for explicit background Shell calls, not background `terminal_send`.

## Alternatives considered

**Parse the launch acknowledgement as an ordinary completed-command result.** The acknowledgement contains no command exit result and can therefore produce a false success indicator.

**Retain Start's running state indefinitely.** The original Tool call has returned, and without a job subscription the card cannot establish that the background job is still running.

**Match subsequent job output back to the original Tool.** This requires a reliable jobId-to-callId association and rules for incremental reads, missing history, and duplicate presentation. None is a prerequisite for displaying the existing command, so they remain outside this decision.

**Keep generic argument JSON as the only presentation.** The data remains available, but the card does not reuse the familiar Shell command presentation and retains an unnecessary difference between foreground and background calls.

## Consequences

Users can inspect the launch command in its original Tool card but cannot infer whether the background job is currently running, successful, or failed. Final state and output remain in the job panel, completion notices, and independent read calls. Component and assembly regressions cover disclosure preservation from Start to acknowledgement, absence of false state and empty output, launch failures, root/child calls, and unchanged foreground and `terminal_send` behavior; assembly-regression event cases use explicitly identified constructed data.
