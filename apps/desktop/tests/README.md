# Desktop local verification

English | [中文](README.zh.md)

## Summary

Local download and mandatory-dialog evidence is separate from production backend integration, visual acceptance, and installed-application upgrades. Run the command in the [Desktop README](../README.md) to produce a fresh isolated report.

Installed qualification can opt into `DSH_DESKTOP_UPDATE_JOURNAL_DIR`, an absolute directory outside the installation tree that both versions retain. Each main process flushes a separate JSONL file with its installed version, state transitions, and manual-operation milestones. Raw diagnostics and request data are excluded; storage errors propagate. The [journal decision](../../../.agents/notes/implemented/testing/2026-09-14-desktop-installed-update-journal.md) defines evidence limits. Unit and main-entry tests cover the journal; a signed installed upgrade is still unverified.

## Table of Contents

- [Fault-report verification](#verification-diagnostics)
- [Update dialog themes](#verification-theme)
- [Native overlay visibility](#verification-overlay)
- [Evidence](#verification-evidence)
- [Manual walkthrough](#verification-interactive)
- [Open verification](#verification-open)

<a id="verification-diagnostics"></a>

## Fault-report verification

See [recovery and diagnostics](../docs/diagnostics/README.md) for product behavior and limitations.

Use a disposable profile and separate Electron `userData` with the actual packaged client. Construct a minimal local bundle with `package.json`, `dsh.bundle.patch` pointing to `cordis.patch.yml`, and an optional plugin module; archive it as a local `.tgz`. These packages deliberately break the application and must not be published or installed in a daily profile.

Exercise import and plugin-initialization exceptions, an asynchronous exception after `appReady`, and a nonzero Host exit. A patch disabling the `agent`, `session`, `llm`, and `tools` providers exercises missing-service diagnostics. To check cross-restart history, select that bundle through `pluginManager`, then restart the same profile. Runtime scenarios require observing actual client readiness; `appReady` alone does not establish that the window is visible.

Check the original error and cause or exit code, operation and Host run IDs across restart, report-collection completion and omissions, file retrieval from the native dialog, and startup after plugin recovery. Record the package version and source commit; successful package generation or a management result alone does not establish client functionality. Restore protocol associations and stop test processes afterward.

For resource checks, use large sparse history files, unrelated files, dense records, and malformed or unfinished lines. Measure setup separately from collection in fresh processes, recording actual bytes read, output size, time, and peak memory. To check Worker cancellation, a test-only module hook can hold an asynchronous file open after writing an entry marker. Confirm that marker, observe Worker exit after the deadline, and compare the basic report bytes. This does not reproduce a kernel-hung system call or establish packaged-client behavior.
<a id="verification-theme"></a>

## Update dialog themes

After `pnpm --dir apps/desktop run build`, run the real Electron palette fixture on macOS:

```sh
apps/desktop/.desktop-build/targets/mac-arm64/electron/Electron.app/Contents/MacOS/Electron apps/desktop/tests/fixtures/update-theme.mjs
```

The fixture creates a private profile, loads the production shell HTML, sandboxed preloads, renderer scripts, and bundled design tokens, and substitutes only fixed IPC status responses. Its 12 cases cover ordinary and mandatory documents starting in light/dark mode, switching while open, and following system appearance. It checks transparent document backgrounds, surface/text/button/mask colors, the code/address surface, the dark-only 1 CSS px inset outline, and the ordinary close icon, then writes four screenshots and `result.json` to `.desktop-build/qualification/update-theme-*`. It does not start a Host, download updates, run an installer, or qualify Windows native rendering. The first-close notice shares the ordinary document's CSS and theme script.

<a id="verification-overlay"></a>

## Native overlay visibility

On macOS, reuse the cached Electron runtime after compiling the Desktop Host sources:

```sh
pnpm exec tsc -b apps/desktop/tsconfig.host.json
apps/desktop/.desktop-build/targets/mac-arm64/electron/Electron.app/Contents/MacOS/Electron apps/desktop/tests/fixtures/update-overlay-visibility.mjs
```

The fixture owns a unique profile and writes `result.json` under `.desktop-build/qualification/update-overlay-*`. It checks visible and hidden owners, absence of native child windows, retention of a separate control window’s focus after owner visibility notifications, and view/input cleanup including owner destruction. It uses no network, product login, or dsh Host. It qualifies the in-window carrier, not the full first-login or installation flow.

<a id="verification-interactive"></a>

## Manual walkthrough

For actual installation, publication after startup, failure/retry, and restart evidence, use the [installed-update operator checklist](installed-update/README.md). The interactive runner below intercepts installation and is a different qualification.

With Host, client, and Desktop artifacts built, run `node --import tsx apps/desktop/scripts/test-workspace-updates.ts --interactive` from the repository root on Windows. The actual workspace stays open with a separate control window. Its menus select ordinary or mandatory updates, hold and release downloads, inject download failures, and queue or clear test tasks. Select a failure before starting the download. After installation approval and task shutdown, a fixture message reports the intercepted installer call; acknowledging it ends the walkthrough. Closing the control window also exits. Each run owns a private profile and loopback server; payloads are not installers. Restart the command for a fresh round. Omitting `--interactive` runs the automated scenarios with their 120-second deadline and automatic exit; interactive downloads have a ten-minute network deadline.

<a id="verification-evidence"></a>

## Evidence

The local command builds Desktop and executes Electron 44 with the actual HTTP updater, policy client, sandboxed preload, and mandatory renderer. It records each scenario and preserves its report under `.desktop-build/qualification/local-updater-*`. The installer call, external browser, and clipboard are observation substitutes; downloaded bytes are not an executable installer.

Packaging supervision fixtures control their Git metadata and use real file hashes with inert child processes. Git-head and worktree changes still refuse packaging; concurrent tests cannot change the fixture’s recorded Git inputs.

| Layer | Observed result |
|---|---|
| Ordinary updater | Same/older-version rejection, user-authorized full download, SHA-512 rejection, interrupted transfer, stalled-feed/download deadlines, explicit retry, coalesced requests, same-address feed replacement, readiness, and separate install handoff pass |
| Mandatory policy | Flattened `40005`, exact release headers, guest requests, no-force validation, failure retention, interval/backoff, timeout, and disposal regressions pass |
| Ordinary scheduling | Fake-clock regressions with the real coordinator verify bounded jitter/backoff, manual joins, success reset, no automatic download retry, wall-clock independence, and disposal. Main-entry tests verify focus/resume throttling, immediate explicit checks, and quit cleanup |
| Actual mandatory window | Text-only server content, an embedded Windows shell frame with no additional native window and an enabled main window, Escape blocking, direct download, same-modal task confirmation, deferral, recovery-only page actions, navigation/copy feedback, and fresh policy clearance pass; focused main-entry tests verify close-to-hide without quitting or stopping the Host, with policy retained |
| Actual ordinary dialog | Isolated preload, 380px card, 24px corners, theme-resolved primary button, translucent backdrop without parent blur, Escape cancellation retaining readiness, and task-warning approval with recorded installation handoff pass |
| Unlocked Windows interaction | OS-level clicks and screenshots of the actual mandatory renderer confirm Escape blocking, user-started download, readiness, red policy-error feedback, and modal clearance with the parent enabled again. A fixture-provided native task-warning dialog returns to readiness on deferral; task activity is simulated, not a full Host workload |
| Main entry | A known block refuses plugin mutations and recovery without stopping the Host; fresh success closes the block; packaged policy ignores environment overrides; installer failure after a clean stop restores the Host before another confirmation and retains mandatory blocking |
| Host task protection | The actual controller with substituted composition detects running agents, queued turns/steps, and global and agent jobs; API reads do not warn. Admission locking returns 503 for new requests, drains existing requests, and rechecks tasks; unlock restores admission |
| Visible output | Chinese mandatory-dialog DOM expectation and ordinary update presentation expectation pass; account-row component tests cover progress and persistent retry |
| Packaging configuration | Metadata embeds the configured application ID and policy; the built pre-pack hook rejects an HTTP policy origin without running packaging or upload |

The focused dialog, main-entry, settings, and sidebar run passes 119 regression cases. Five carrier tests cover all statements, branches, functions, and lines of the shared update-status source. The real-Electron command passes 17 scenarios and captures ordinary-ready, task-warning, and mandatory-error dialogs. These isolated checks do not certify the complete workspace or a release. Full-repository gate results and environment limitations remain separate from this focused evidence.

Chromium headless shell revision 1228 is installed in the ignored `.desktop-build/playwright` directory. The assembled settings and sidebar browser suites pass 18 cases. The [Desktop workspace browser scenario](../../web/tests/desktop-updates.e2e.ts) passes both Chinese and English cases, captures six screenshots per locale, and verifies bottom-row placement, compact progress with duplicate-click rejection, a top-toggle badge, persistent red retry with error tooltip, and a separate ready action. The presentation function, Host Web composition, client plugins, and CSS are real; the Desktop carrier is substituted. These cases do not exercise Electron IPC, menus, task authorization, or installation.

The [built Host scenario](fixtures/host-update-qualification.mjs) uses the actual profile Loader, standard agent preset, task services, and Node background processes. It verifies queued turns/steps, a running model request, pending questions/approvals, global and agent jobs in running/stopping states, admission locking without cancellation, restored admission, and rejected inspection after Host disposal. Only model responses and human answers are substituted. Two independent invocations pass concurrently with private profiles and session data; all owned agents, jobs, and Hosts finish before a success report is written.

The [Electron workspace runner](../scripts/test-workspace-updates.ts) executes a private copy of the compiled main entry with the real preload, workspace, and separate Host process. It acknowledges the first-run notice and drives renderer buttons through Electron input events and Chromium debugger input for the embedded Windows frame. The private application reuses the prepared target runtime resources. The recorded Windows run passes ten scenarios, covering menu feedback, download failure and retry, separate installation confirmation, real confirmation-time task creation, deferral, mandatory blocking, and actual Host teardown timeout. Both ordinary and mandatory failures restore a replacement Host and require fresh installation confirmation; recovery does not clear mandatory policy. Delivery uses a local server and installation is intercepted; these are not signed installed-app results. The macOS workspace path has not completed qualification; these Windows results do not cover it.

The [Windows signature runner](../scripts/test-windows-update-signature.mjs) uses the installed electron-builder metadata generator and `NsisUpdater` verifier with the public release certificate and real executable inputs. Matching publisher attributes pass; the same valid signature with a different expected publisher and an unsigned executable are rejected. A missing-publisher negative control confirms that verification is skipped. Unit regressions cover DN escaping, incomplete identities, and explicit or host-default Windows targets; removing the publisher configuration fails both metadata cases. This check does not download, install, or sign an artifact.

The [signed-download runner](../scripts/test-signed-updates.mjs) connects real Electron HTTP, `NsisUpdater`, Windows Authenticode, and the built coordinator. Four scenarios pass: valid-hash wrong-publisher rejection, valid-hash unsigned rejection, corrupt-transfer rejection before signature verification, and explicit retry to signed readiness with separate installation handoff. Rejected executable caches are empty, automatic checks issue no retry request, prepared downloads are retained, and original inputs keep their SHA-512. The synthetic feed and test application adapter do not establish installed-version compatibility; no installer or Host starts.

With an old installer and both original blockmaps, the same runner additionally verifies single-range and multipart-range reconstruction, missing-old-blockmap fallback, and rejected-range fallback. Reconstructed executables pass SHA-512 and Authenticode checks. Request records distinguish differential payload bytes from full downloads; a full fallback cannot satisfy a differential-success assertion. These loopback results do not certify CDN Range support or an installed application's cache.

<a id="verification-open"></a>

## Open verification

The following items are not passing evidence and must remain visible during review:

- Electron `capturePage()` captures individual windows. Windows interactive observations include composed dialogs and native menu selection, but cross-platform Figma/layout acceptance and a complete recording remain unverified. The automated workspace runner invokes the menu handler directly.
- The development launcher encounters a dangling optional Linux ARM64 dependency junction in this Windows checkout; the qualification runners link the existing dependency graph directly and do not validate that launcher's projection.
- The fixture does not execute an installer, overwrite an installed application, or establish that a new version starts successfully. Signed Windows and macOS installed-version qualification remains required for release.
- Two isolated Windows test installers pass signed-package inspection, including their embedded feed configuration. Installed startup, failure/retry, automatic restart, and data retention remain operator verification; file inspection does not certify a release.
- Live policy origins, gateway behavior, rate limits, approved page origins, and deployed policy configuration are pending backend integration. Local responses are not proof of a live service.
- Policy, updater feed, and updater download stalls reach their real deadlines and recover. Injected download-write `ENOSPC` is covered; actual volume exhaustion and installed-upgrade disk pressure remain unverified. Differential download and publisher rejection are verified through real Electron downloads, but not yet in a newly packaged application's installed-upgrade path.
- Native clipboard writing passes on Windows. Default-browser launch is attempted, but destination verification stops because the automation tool cannot reliably identify the current URL. macOS browser and clipboard integration remain unverified.
- Mandatory and ordinary failures use localized summaries and folded diagnostics; copy failure reveals a selectable address. Ordinary error tooltips show summaries rather than raw diagnostics. Installed Windows/macOS attention, notification permission, and focus-mode behavior remain unverified.
- Full `doc-sync` encounters Windows file-symlink `EPERM` in the documentation-site test. This is not an updater failure and does not make the full documentation gate green.
