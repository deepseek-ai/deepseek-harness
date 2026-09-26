# Agent Note: Windows runtime signature cache

Status: implemented

English | [中文](2026-09-17-windows-runtime-signature-cache.zh.md)

## Problem

Windows packaging reconstructs unsigned native dependencies on each build. Signing unchanged Python and LibreOffice files repeats hardware-token and timestamp operations. Starting PowerShell for each public-key inspection also repeats process initialization.

## Decision

Cache complete signed runtime files by original content, public certificate, SignTool bytes, signing-script bytes and cache format. Keep valid vendor signatures. Restore a cache hit through a private staged copy only after checking the input record, signed-file digest, Windows trust, timestamp and configured certificate; reject invalid entries without automatic repair or hardware fallback. Publish complete entries atomically, and retain an existing valid entry when concurrent publishers collide.

Share the cache only within the current Windows account. Require a fixed local drive, current-account ownership and a private destination DACL; reject linked or redirected paths. Programs running as that account remain trusted. Explicit migration copies complete integrity-checked entries without modifying its source or replacing an existing valid entry. Different timestamp bytes at the same input/policy key do not require replacement; every actual restoration still verifies Windows trust.

The default cache lives beside the account's existing signing state under the user profile. AppData is unsuitable for this default because an MSIX launcher can redirect new files into its private package storage, separating otherwise identical worktrees launched from different programs. A validated explicit directory remains available for isolated build storage.

Serialize each complete signing stage and cache-maintenance operation with an exclusive Windows file handle. The lock covers preflight, primary-runtime signing, application-runtime signing and artifact creation separately, leaving compilation and preparation concurrent. A waiter rechecks the cache after acquisition. Stage ownership and the retained hardware-attempt interlock have different lifetimes: closing the stage handle releases contention, while hardware failures and interruptions retain the existing attempt evidence and never authorize an automatic retry.

Group public-key inspection into bounded batches of 32 files with at most four processes. Require one ordered result for every requested path and await every process in a failed batch. Preserve verification immediately after each hardware signature, before the next signing request.

Within the stage lock, restore distinct cache-hit targets with a bounded worker pool and complete their post-verification before serially signing misses. Stop dispatch on the first restore, verification or audit failure and drain active workers before releasing ownership. Four workers are the configurable default: warm-cache experiments on 134 primary-runtime and 228 application files reduce combined median restore-plus-post-verification time from 226.18 seconds at one worker to 63.22 seconds at four; eight takes 42.18 seconds but increases measured CPU by 25.5% and peak committed memory from 387 to 631 MiB. These three-repeat measurements use exact reconstructed unsigned inputs, real Windows verification and a rejecting hardware callback; they exclude full packaging, cold trust state and hardware misses.

The [primary-runtime decision](../feature/2026-09-14-desktop-primary-runtime.md) continues to own runtime contents, vendor-signature preservation and execution checks. The [release decision](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md) continues to own release identity and signing. Neither is superseded. The cache must preserve their supervised preflight, per-user signing interlock, single-file hardware calls, signed inventory and final packaged-runtime validation.

## Alternatives considered

**Multi-file hardware signing.** The primary-runtime decision records that SignTool can continue after the first file fails. Reducing repeated hardware work through caching preserves the existing stop behavior.

**Detached signature extraction and attachment.** Complete-file caching avoids adding PE-signature manipulation to packaging. Its additional disk use is measurable and confined to build storage.

**Whole signed-runtime artifacts only.** They can also avoid extraction and copying, but require assembly and dependency-graph identities. Per-file caching can reuse unchanged native dependencies when application code or one dependency changes.

**Per-entry locks only.** They avoid duplicate signatures for one key but do not coordinate different files, preflight or installer signing against the same hardware token. Stage-wide ownership covers those calls without holding a lock during unrelated compilation.

**Cache-age expiry.** Age alone does not establish that a timestamped signature is invalid. Rechecking current Windows trust preserves the validation requirement without periodically repeating unchanged hardware signatures.

## Consequences

Repeated builds with unchanged native inputs avoid hardware calls for cached files while retaining preflight and final artifact signing. Changed content or signing policy misses the cache. Corrupt, incomplete, untrusted or incorrectly timestamped entries fail without replacing the target or retrying hardware. Concurrent publication and interrupted processes cannot expose incomplete entries or damage another build's files.

Complete signed Windows x64 builds on one host measure an empty shared cache and reuse from a separate fresh worktree: hardware calls fall from 379 to 17, elapsed time from 37:03 to 13:45, and all 362 runtime entries hit. Cache restoration takes 132 seconds, including 130 seconds of current trust verification. Both builds pass final runtime smoke and signed-artifact checks. Downloads are prepared before timing; each scenario is one complete run. A separate controlled native-file change produces miss/hit/miss with two hardware calls; it tests invalidation, not a dependency-version upgrade. Installer execution and update qualification remain separate.

## Risks

The cache consumes local disk and depends on the build account controlling its files and records. It is not a distribution format for untrusted remote caches. Signature validation still depends on Windows trust services; cache hits do not authorize clearing a signing interlock or retrying a failed token operation. A timestamp-service failure can interrupt a cold build even after a successful preflight.

No automatic capacity eviction runs. Explicit maintenance waits for stage ownership and retires complete entries before deleting their files; interrupted staging directories remain distinguishable from published entries. Runtime summaries count actual publications separately from retained collisions, and report cache verification time separately from signing time. They do not measure the entire package's verification cost.
