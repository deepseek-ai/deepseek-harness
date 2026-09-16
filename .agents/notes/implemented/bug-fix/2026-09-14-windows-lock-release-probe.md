# Agent Note: Windows lock release before contention probing

Status: implemented

English | [中文](2026-09-14-windows-lock-release-probe.zh.md)

## Problem

Windows exclusive file creation can report `EPERM` while another writer owns the lock. The holder can remove the lock before the contender's `lstat`, so absence at that later observation does not prove the create failed for a persistent permission restriction. The profile module-fallback contention test exposed this race.

## Decision

`withFileLock` permits one unconfirmed `EPERM` retry per Windows acquisition, using the existing backoff and deadline. Confirmed contention still waits normally. A second unconfirmed permission failure is rethrown, and the protected operation runs only after exclusive creation succeeds.

## Alternatives considered

Retrying every permission error until timeout would obscure persistent permission failures. Requiring the lock to exist during the later probe rejects a valid release race. Delaying the test's holder release changes timing without repairing the writer protocol.

## Consequences

A persistent Windows permission failure can incur one backoff before failing. POSIX behavior is unchanged. The atomic-write tests force release before the probe and verify both successful acquisition and persistent permission rejection; the profile tests exercise real competing writers. Existing credential-registration notes retain ownership of write serialization and are not superseded by this acquisition rule.
