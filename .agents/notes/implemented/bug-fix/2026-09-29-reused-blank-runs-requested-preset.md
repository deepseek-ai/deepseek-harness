# Agent Note: A reused blank Session runs the requested preset

Status: implemented

English | [中文](2026-09-29-reused-blank-runs-requested-preset.zh.md)

## Problem

Web New Session, Workspace navigation, and startup restoration reused a blank Session by naming it in `session.create`. The Host resumed that Session under the preset its log recorded, so a new conversation inherited the preset the blank had been created or switched under. When that preset was no longer declared, such as a removed or renamed definition or a legacy `$DSH_HOME/.agent-presets/<id>/` directory that nothing reads any more, every New Session in that Workspace and every startup restoration of that draft failed with `agent-preset/not-found` although the default preset was valid (issue #2566). A blank created under an earlier default silently kept that default. The client retried only `session/writer-held`, so the stale blank stayed first in line.

## Decision

`session.create` returns a Session for a new conversation. A named `sessionId` is a reuse candidate that the Host verifies: it must not have started a turn, must belong to the requested directory, must be an unarchived member of the requested Workspace, and must not be written by another owner. For a persisted candidate the Host repeats the started check under the writer it acquires. Requests naming one identity run in arrival order, including their preset resolution, and the directory and ownership checks precede that resolution. The reused Session runs the requested `agentPreset`, or the configured default when the request names none; the Host does not resolve the recorded preset for reuse. When the target differs, a live Session switches through the preset registry's `select`, and a persisted Session mounts the target in its unpublished resume setup and appends `agent-preset/selected` there, so the log names the composition before the Agent is published. A candidate that has started, fails placement, or is written by another owner stays unchanged, and the Host creates a new Session; the response names the Session used. An explicit request for an undeclared preset still fails with `agent-preset/not-found`, and resuming a started Session still resolves its recorded identity.

The Web client names the first eligible blank when it connects a Workspace or prepares an explicit draft, and passes the preset a flow knows before it starts, such as the creator entry's `cordis`; a plain New Session creates a fresh Session instead. Startup restoration names the saved blank with the preset its log recorded, reloading the Session's projections first because listed values are cached hints that can lag the log after an unclean Host exit, so a draft keeps its selection; after `agent-preset/not-found` or `agent-preset/invalid` it asks again without a preset, and the draft continues under the default. When the Host declines a named blank, the client reloads that Session's projections, because stale cached list metadata can still mark a started conversation blank and hide it from the Session tree.

## Alternatives considered

**Fall back to the default only when the recorded preset is missing.** This removes the failure but keeps an inherited preset whenever it still resolves, so a New Session after a default change runs the old default.

**Retry `agent-preset/not-found` in the client.** The stale blank stays the first reuse candidate, so later New Sessions fail once before creating another Session, and startup restoration and other callers still fail.

**Skip blanks whose preset is missing from the roster.** Navigation would need the roster, stale Sessions would never be repaired, and other callers would still fail.

**Let the Host choose the blank.** The Host would scan the catalog on every request, while the client already holds the ordered catalog; verification under the writer covers a stale client view.

**Keep a restored draft's preset on the Host when it resolves.** A request that names a blank without a preset would then mean "keep" for restoration and "default" for New Session. Passing the recorded preset gives each request one meaning.

## Consequences

A reused blank runs the default or the preset its flow names, including after the default changes or a definition disappears. A preset picked on a draft survives a page reload but not a later Workspace connection or draft preparation that reuses the draft, and reusing a draft that another tab shows changes that tab's preset too. Writer contention no longer reaches the client: the Host creates the replacement Session. A blank whose first prompt was accepted but whose turn has not started still counts as blank, as it does for `select`. A declined stale blank is corrected only in the client that named it, until the Session is next activated. The preset registry's `select` leaves a blank Session that records the requested preset and runs its current revision unchanged, so a client that also selects that preset after the creation request adds no second record.

This note replaces the client-side contention fallback of [Writer acquisition for blank Session reuse](../architecture/2026-09-17-process-local-blank-sessions.md); writer acquisition and candidate order remain as decided there.

## Testing

Session Controller tests cover live and persisted reuse, a recorded preset that is no longer declared, named presets, started and overtaken Sessions, writer contention, Workspace placement, storage failures, arrival order when an earlier preset resolves later, and directory checks before preset resolution. Workspace navigation tests cover restoration with and without a usable recorded preset, restoration when the listed preset lags the log, connection coalescing that a different preset request supersedes, and the projection reload for a declined blank; the preset plugin tests cover the creator entry, and the registry tests cover a repeated selection with and without a replaced definition. The shipped Web composition test reuses a blank recorded under an undeclared preset under the default when startup connects its Workspace and when startup restores it, keeps a restored draft's declared preset, and checks the durable `agent-preset/selected` record; the stale blank cache scenario checks that startup opens a new Session and still lists the declined conversation.
