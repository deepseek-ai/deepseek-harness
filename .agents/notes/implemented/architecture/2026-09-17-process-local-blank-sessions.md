# Agent Note: Writer acquisition for blank Session reuse

Status: implemented

English | [中文](2026-09-17-process-local-blank-sessions.zh.md)

## Problem

Two Hosts sharing Session storage can select the same blank Session when opening a Workspace. A blank Session already owns a live Agent, accepts slash commands, and can hold its writer lock after the creation checkpoint. An unowned persisted blank also carries command settings that remain useful after a Host restart.

## Decision

The Session catalog includes persisted blanks. Startup restoration selects the saved blank; ordinary Workspace navigation selects the first eligible unarchived member in catalog order. Explicit-id `session.create` resumes that Session and acquires its writer before opening history. Only `session/writer-held` triggers creation of a new Session. Other errors propagate. Concurrent Workspace connects in one Client share the acquisition and fallback. Later navigation cancels a pending startup selection.

The Agent retains the acquired handle throughout its lifetime. Checking ownership and releasing a probe lock would leave a race before resume. No PID or process identity enters persisted data or the Remote schema.

This decision extends the blank-reuse policy in the [Client Session scope decision](2026-07-25-web-client-session-scope-and-provide-channel.md); its real-Session slash support and Provider adoption rationale remain active.

## Alternatives considered

**Client-only drafts.** Slash commands and Session-scoped plugins require a real Session before the first prompt. Deferring creation requires a separate command lifecycle.

**Release a live blank's writer lock.** Blank means no `turn/start`, not no events. A live Agent can still append command and configuration events, so releasing its lock permits competing writers.

**Hide every cold blank.** This discards reusable command settings from navigation and creates another blank after every restart, even when the old writer is free.

**Persist a creator PID.** Kernel writer ownership already arbitrates acquisition. PID reuse and stale creator records add no authority.

## Consequences

A Host can reuse its own live blank or reclaim an unowned persisted blank with its slash state. Separate Hosts create distinct blanks while existing writers remain held. A held selected blank causes fresh creation even when another blank is free; navigation does not search for another candidate. No cleanup is added. Opening the same established conversation from two Hosts can still encounter writer contention. Unknown projection hints remain visible without cold body scans; automatic reuse requires known blank metadata. A non-contention acquisition failure aborts New Session and is currently reported only to the console; hidden blanks have no recovery action in this flow.

## Verification

Navigation tests cover saved selection, single-candidate contention fallback, non-contention failures, overlapping acquisition, and superseding navigation. A shipped Web-composition test holds a real persistence writer, verifies fresh creation despite another free blank, and reclaims the released selected blank with its plan state. The fresh-round-trip recorded Session scenario reloads its blank before submitting the recorded prompt.
