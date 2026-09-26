# Agent Note: Qualify Desktop update downloads with an isolated local server

Status: implemented

English | [中文](2026-09-10-desktop-local-updater-qualification.zh.md)

## Problem

Desktop update interaction depends on feed parsing, network failures, download integrity, and platform preparation. Simulated updater events cannot establish that these operations work together. Requiring cloud cache configuration and hardware signing for each feedback cycle makes local product validation depend on release infrastructure.

## Decision

The [Windows local qualification command](../../../../apps/desktop/README.md) runs the built production coordinator inside Electron with the real `ElectronHttpExecutor` and `NsisUpdater`. An isolated application adapter supplies a test version and private update configuration. A loopback server supplies Nightly YAML, mandatory policy, and inert binary bytes. The installer, external browser, and clipboard calls are replaced with observations. Publisher verification is absent only from this private fixture configuration, never from production configuration.

Each invocation atomically allocates a temporary directory and an operating-system-assigned loopback port. Request barriers establish concurrency without sleeps. Server close and child exit are awaited before temporary files are removed. Independent processes can run concurrently without sharing updater cache or user data. The command requires built Desktop modules and stays separate from source-plane unit tests.

This testing decision supplements the [release policy](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md); it does not supersede signing, publication integrity, installed-artifact qualification, or the pending [mandatory update proposal](../../proposed/feature/2026-09-08-desktop-mandatory-update-api.md). Those records remain active.

## Alternatives considered

**Use only simulated updater events.** They cover state transitions but cannot establish actual YAML parsing, Electron transport, downloaded bytes, or checksum rejection. Local qualification uses real dependency implementations; native-dialog and renderer component tests remain separate.

**Require signed cloud-hosted packages for every local iteration.** That couples ordinary interaction debugging to signing hardware and CDN configuration. Release qualification still requires those systems, but local download tests do not.

**Relax production signing or execute a dummy installer.** Neither is needed to observe download readiness and installation authorization. The fixture never loads production update configuration and records installation without launching downloaded bytes.

## Consequences

The executable scenarios cover no update, downgrade rejection, HTTP 404/408 and invalid YAML, stalled-feed and stalled-download deadlines, same-address feed replacement, one in-flight check or download, explicit download authorization, SHA-512 mismatch, interrupted transfers, explicit retry, prepared-version retention, restart refusal, shutdown failure, and disposal during a pending check. Native-dialog regressions cover checking feedback, check failure, download refusal, and separate installation action; account-row tests own progress and persistent retry presentation.

The ordinary polling regression uses the real coordinator with a fake clock, instance-local random samples, and deferred network completion. It verifies completion-based jitter, capped exponential backoff, successful reset, manual failure visibility while joining an automatic check, retained download failures and prepared packages, and no timer rearming after disposal. Main-entry tests connect the same deadline to focus, resume, explicit IPC, and application shutdown. Removing failure backoff makes the timing assertion fail. These deterministic tests establish request timing, not fleet capacity or startup-burst distribution.

The actual [mandatory-update window](../feature/2026-09-11-desktop-mandatory-update-client.md), sandboxed preload, and renderer button handlers run against the policy server and updater. A stalled policy request reaches its real deadline without clearing the block. Owner-local DOM expectations pin Chinese text and actions. Screenshot failures are recorded separately; missing screenshots cannot establish visual acceptance.

The [workspace browser scenario](../../../../apps/web/tests/desktop-updates.e2e.ts) checks built sidebar composition in both locales against the production presentation function. A page-local carrier supplies update state and records actions; the Host, client plugins, styles, and connection remain real. This separates slot placement and click-guard evidence from Electron IPC, task authorization, and installation evidence. Screenshots and result files use an invocation-specific ignored directory and do not replace release qualification.

The [Host qualification runner](../../../../apps/desktop/scripts/test-host-updates.ts) loads the built Host and standard agent preset in a private profile. Real task registries, queued messages, pending tool questions/approvals, and Node jobs establish task-detection and admission-lock evidence without replacing Host composition. Scripted model output and held human answerers control the waiting points; cancellation and process exit establish completion. This evidence excludes the development launcher's dependency projection, Electron installation confirmation, and failed task shutdown. Concurrent invocations own separate home, project, and session directories.

The [Electron workspace runner](../../../../apps/desktop/scripts/test-workspace-updates.ts) couples the compiled main entry and actual preload to a separate real Host. A private profile plugin controls real queued tasks and deliberately holds teardown; local HTTP delivery replaces release infrastructure, and the updater's installer call is intercepted. It verifies confirmation-time task changes, refused installation after failed teardown, replacement Host readiness, and fresh confirmation under ordinary and mandatory policy. Renderer actions wait for finite layout animations and reject obscured targets; window-listener cleanup retains web contents independently of destroyed windows. The runner does not prove bundled-main deployment or operating-system composition of overlapping windows.

The runner launches Electron without hiding its GUI and asserts main-window visibility before input or screenshots. Hidden or occluded renderers can suspend frame callbacks even when DOM queries complete. Each DOM, click-layout, and screenshot operation temporarily disables background throttling on its own WebContents, then restores and checks the original setting. Real animations and click-obscuration assertions remain enabled; production window configuration is unchanged. A main-process deadline and invocation-local trace bound each operation; failure diagnostics record window visibility and animation state with their own deadline. Diagnostic capture failure cannot replace the original test failure. Re-enabling Windows process hiding fails the visibility assertion, and concurrent unprotected windows reproduce a suspended frame wait.

The production `DesktopUpdateHttpExecutor` retains the library transport and adds an inactivity deadline to actual Electron requests. Electron 44 emits writable `close` before response headers, so that event cannot indicate HTTP completion. Response completion, abort, and errors release the timer; received bytes refresh it. Both stalled headers and stalled payloads fail and recover through an explicit retry in the local fixture.

The [signed-download runner](../../../../apps/desktop/scripts/test-signed-updates.mjs) complements inert-byte tests with existing signed and unsigned executables, a public certificate, and real Windows Authenticode verification. Its private feed uses a synthetic version, and installation is intercepted. Correct-hash files with a wrong publisher or no signature are rejected and removed from cache; corrupt transfer bytes fail checksum verification first. Automatic checks retain the failure without another request, while explicit retry with a signed payload reaches readiness and requires separate restart approval. Inputs remain unchanged. Each process owns its port and cache; the deadline stops its complete Electron/PowerShell process tree before runtime cleanup. Missing publisher configuration makes the rejection assertion fail.

Optional old-installer input enables real differential reconstruction from private cache and original blockmaps. The server supports single and multipart byte ranges, with explicit missing-blockmap and rejected-range failures. Hash and signature verification cover reconstructed and full-fallback results; request records require actual byte reuse and reject full fallback as differential success. Disabling differential download fails the blockmap-request assertion. Historical input files remain read-only, and independent concurrent runs retain separate caches and ports.

The local download fixture injects `ENOSPC` into its executable write stream after writing partial bytes to disk. The actual updater must clear the partial executable, refuse installation, retain explicit retry, and download verified bytes after the original writer is restored. Only the private download path is intercepted, and stream closure is awaited. This qualifies handling of a filesystem write failure without exhausting a shared host volume.

This evidence does not establish actual installer execution, post-restart health, production CDN Range behavior, macOS updater preparation, or actual volume exhaustion. The test servers publish nothing and never read cloud credentials; production delivery and signed installed-version upgrades remain separate qualification.
