# Agent Note: Session writer contention feedback

Status: implemented

English | [中文](2026-09-16-session-writer-held-feedback.zh.md)

## Problem

A Session can retain its write handle while its Agent is idle. Another Host cannot resume that Session, but a generic internal-error toast gives the user no recovery guidance. The holder can also belong to the same process, so contention alone does not identify another running application.

## Decision

Session Controller reports `session/writer-held` with `{ sessionId }` when resume fails with `SessionAlreadyOwnedError` and no reusable Agent exists. Clients discriminate by code, following the [Remote failure vocabulary](../architecture/2026-08-28-ctx-remote-failure-vocabulary.md). The controller recognizes the persistence error by its Error name, matching Session Query's optional-dependency handling; loading the controller requires no persistence implementation or error-class identity.

Send and model-selection failures show localized guidance that another DSH instance may hold the Session and suggest quitting other instances before retrying. Model selection returns the original Remote result to both UI entries; error classification does not depend on a later read of shared directory state. The [write-lease decision](../feature/2026-08-31-cross-process-session-write-lease.md) continues to own locking and release semantics; this feedback neither takes ownership nor retries writes automatically.

## Alternatives considered

**A free-text reason under `session/agent-busy`.** A second string discriminator loses the code-to-details type relationship and mixes write contention with prompt admission failures.

**A separate directory flag or a required persistence peer.** A flag duplicates the operation's failure and can become stale after a catalog refresh. Making persistence mandatory solely to identify its error removes support for deployments without persistence.

## Consequences

The wire gains one typed failure code without changing stored Session data. Recovery guidance cannot identify which process owns the handle. Host tests cover the error name and ordinary failures with and without persistence; Client tests cover both locales and operation-local model failures. The keyless `queue-actions` Web scenario pins the writer-held toast and preserved draft through the shipped composition. `verify-optional-dependency-imports` guards module loading against optional value imports.
