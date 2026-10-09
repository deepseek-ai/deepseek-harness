# Agent Note: Packed-install verification owns its npm cache

Status: implemented

English | [中文](2026-09-06-packed-install-private-npm-cache.zh.md)

## Problem

The [packed-install verifier](../../../../scripts/release/verify-packed-install.ts) removes its temporary consumer but an npm install using the ambient cache leaves tarball content and logs outside that cleanup. Repeated release rehearsals can therefore grow the shared runner user cache even when every consumer is removed. A full root filesystem can fail unrelated CI jobs.

## Decision

The verifier passes `--cache <consumerRoot>/.npm-cache` only to its npm install invocation. The explicit argument overrides npm environment and user-configuration cache settings without changing the environment of the installed executable. The existing `finally` removes this cache together with the consumer after success, an install failure, or an executable failure.

The [release sequence decision](../process/2026-08-10-npm-release-sequences.md) still owns artifact selection and publication. This decision only adds cache ownership to the verifier; it does not change other npm consumers.

## Alternatives considered

- **Delete the shared user cache:** unrelated jobs also own its contents. The verifier must not delete shared host state.
- **Change global `TMPDIR` or npm configuration:** that affects processes outside this invocation and is unnecessary when the consumer already has an owned temporary directory.
- **Keep a persistent verifier cache:** that retains cross-run downloads but requires a separate retention policy. Invocation ownership accepts repeated downloads instead.

## Consequences

This prevents this verifier from adding content to the ambient npm cache; it neither reclaims existing host cache contents nor guarantees that disk exhaustion from other producers stops. External dependencies can require fresh downloads on each invocation. A forced termination that prevents `finally` from running can leave the consumer and its cache behind; this change adds no crash-recovery cleanup.

## Verification

[The focused regression](../../../../scripts/release/verify-packed-install.spec.ts) runs the real verifier and npm offline against a tiny local tarball. A lifecycle script records actual private `_cacache` files before cleanup. The tests verify consumer removal after success, npm install failure, and installed-entry failure, while inherited environment and user-config cache canaries remain unchanged. Removing the cache argument makes the private-cache assertion fail. The executable test follows the POSIX release runner path; it does not exercise Windows command-shim resolution.
