# Agent Note: Durable Computer Use consent within one profile

Status: implemented

English | [中文](2026-10-19-cua-profile-consent-storage.zh.md)

## Problem

Application grants stored as plugin configuration make each authorization change depend on configuration reconciliation. Process-local conversation decisions also disappear when the same conversation resumes after a restart. A shared in-memory storage handle cannot observe another process revoking permission.

## Decision

The CUA owner uses the existing domain storage service, with one domain per canonical profile directory. It stores long-term grants and conversation decisions by native application identity. Conversation IDs scope permission without turning it into permission for every conversation. The native identity policy remains owned by [bundle-ID consent](2026-10-25-cua-bundle-id-consent.md); this note replaces only that note's storage and restart-lifetime choices.

Every operation opens fresh domain state while holding the profile's existing file-lock primitive and closes the domain before releasing the lock. Native dispatch and revocation use a separate lock for the selected application. Storage reads and unrelated applications remain available during a native call. Revocation cancels this process's affected work first, then commits after other processes' already-admitted operations have finished. A completed revocation therefore leaves no operation using the old authority. App-wide revocation generations and per-conversation decision revisions prevent an old handle or delayed answer from restoring revoked access.

The JSON backend remains the shipped default. The domain name contains the SHA-256 digest of the canonical profile directory, isolating profiles that share one storage root. Legacy `allowedApps` is imported once; a persisted migration marker prevents an old configuration from restoring a revoked grant. Users can remove that configuration after checking the migrated list. Corrupt or unavailable profile storage fails closed. A composition without a profile has only temporary conversation state.

## Alternatives considered

**Keep authorization in configuration.** It preserves existing storage but retains configuration-write and HMR coupling for runtime application decisions.

**Keep one domain open and rely on change events.** Domain notifications are process-local. Another host could continue to use stale grants after revocation.

**Add a new watcher, revision file or authorization broker.** The existing domain and file-lock primitives provide fresh reads and serialized operation admission without a new shared storage or IPC framework. Operations on the same application are serialized across processes; other applications and their conversation decisions remain independent.

## Consequences

File locks coordinate processes on one machine and PID namespace. A network-mounted profile shared across hosts is unsupported. Revocation may wait for another process's native call to settle. No timer establishes authorization validity.

The permission page still omits conversation-only grants and reads current state on entry, focus, actions and reconnection. Storage changes do not emit configuration events. System permissions remain owned by macOS. Tests cover restart retention, profile isolation, another process's write, cancellation, corrupted data, legacy import and non-resurrection after revocation. Stored conversation records currently require explicit retention management rather than automatic eviction.
