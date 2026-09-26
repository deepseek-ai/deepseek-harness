# Agent Note: Deferred Desktop update extensions

Status: proposed

English | [中文](2026-09-08-desktop-update-extensions.zh.md)

## Problem

Frequent releases may eventually benefit from independently revised Desktop packages, a stable subscription, next-launch installation, or replacing an older pending update. These choices introduce additional release and installer states that are not needed to ship the initial fixed-Nightly, explicitly approved installation flow.

## Proposal

Keep these candidates separate from the [initial update design](2026-09-08-desktop-update-policy-and-installation.md). None is an initial acceptance requirement or authorization to change dependencies. Product approval and platform qualification are required before implementation. The [mandatory-update API](2026-09-08-desktop-mandatory-update-api.md) remains independent; automatic installation does not add installer fields to it.

### Independent revisions

If Desktop-only fixes become necessary on a prerelease line, evaluate the reserved `.dsk.N` format. Keep full SemVer comparison so introducing it does not require a custom version parser. The intended ordering is:

```text
0.1.3-rc.2
< 0.1.3-rc.2.dsk.1
< 0.1.3-rc.2.dsk.2
< 0.1.3-rc.3
```

Such a release would record Desktop `0.1.3-rc.2.dsk.1` separately from bundled dsh `0.1.3-rc.2`. Introduce independent `desktopVersion`, `bundledDshVersion`, and `releaseChannel` records only with corresponding build, runtime descriptor, profile reconciliation, publisher, and backend-policy validation. The initial build continues to require equal versions.

Do not use `0.1.3-dsk.1` to repair stable `0.1.3`: SemVer orders it below the stable release. Stable fixes require a higher shared dsh/Desktop patch version, such as `0.1.4`. Independent prerelease revisions are an exceptional release path, not a routine per-build counter.

### Stable subscription and channel switching

| User option | Feed | Release contents |
|---|---|---|
| Stable | `latest.yml` / `latest-mac.yml` | Stable only |
| Nightly | `nightly.yml` / `nightly-mac.yml` | Alpha, rc, and stable |

The [initial publication rule](2026-09-08-desktop-update-policy-and-installation.md) adds the stable feed when shared stable releases exist, without switching fixed-Nightly clients. A user-facing stable subscription and selector remain deferred. If enabled, persist the selected channel; never infer it from the installed version. Preserve `allowDowngrade = false` when assigning the updater channel. Moving from Nightly to stable keeps a higher installed Nightly until a higher stable version exists, without downgrading Desktop or bundled dsh.

Channel switching may immediately check; download behavior must follow the approved setting. Ignore old-channel responses and reconfirm downloaded artifacts against the new channel before installation. A channel change does not clear mandatory blocking without a valid policy response for the new conditions. Display a persistent Nightly explanation under the selector, with candidate Chinese copy “提前体验新功能，版本可能不稳定。”; hide it after selecting stable, while separately explaining any wait for a higher stable version.

Design compatibility only for Desktop packages actually distributed. If a future migration has real clients reading `alpha.yml` or `rc.yml`, publish a higher bridge version to the old feed and Nightly until the old entry can be retired. No such bridge is required initially.

### Automatic-installation setting

The candidate setting is automatic installation, potentially enabled by default only after product approval and measured platform behavior. Candidate Chinese helper text is “关闭后仍会提示更新，需手动升级。” If next-launch installation is not acceptable, evaluate a download-only setting and retain explicit installation confirmation.

| Setting | Newer version discovered | Later complete app launch |
|---|---|---|
| Enabled | Download and prepare automatically, including discovery from a manual check | Apply a valid pending update when installation conditions hold |
| Disabled | Continue checking and prompting; wait for explicit download | Do not install automatically; keep the manual path |

Automatic download and installation in this table are deferred product choices; the initial release requires user action for every download and separate installation approval. Turning a future automatic setting off prevents new automatic downloads and installations; an active download may complete without a new cancel button. Determine whether platform-staged installation can be cancelled before promising immediate effect. Never proactively exit a running app or bypass task-impact approval. Preserve initial check triggers and feedback, without adding network-recovery checks or unsolicited global indicators.

### Next-launch installation

Target a complete process launch, not reopening a window or reloading the renderer. Prefer installation before restoring business tasks or starting local dsh; surviving managed resources require explicit shutdown approval. A cached ZIP or installer is not proof of completed native preparation. Surface extraction, verification, and preparation honestly without fabricated progress.

Use the already prepared target instead of delaying launch for a fresh package download. A bounded check may discover a newer candidate and defer this installation while the current app opens, but only if the platform still permits abandoning the staged target. Native installer handoff may prevent cancellation or retargeting; never simulate it by deleting native staging directories. Measure download-to-ready, click-to-exit, replacement, and new-version profile reconciliation and Host startup separately.

### Updater dependency qualification

The initial dependency declaration remains in [Desktop package metadata](../../../../apps/desktop/package.json). A coordinated electron-builder 27 / electron-updater 7 migration is an evaluation candidate, not a dependency bump authorized here. The following API and platform items require verification against the selected release and real packages; this proposal does not claim they have been exercised locally.

| Candidate item | Required qualification |
|---|---|
| `autoInstallEvent` | Verify `manual`, `onQuit`, and `onNextLaunch`; migration alone must retain manual installation |
| Object-form `quitAndInstall` | Verify `isSilent` and `isForceRunAfter`, plus macOS-specific semantics |
| Next-launch cache | Re-fetch metadata and validate artifact hashes and platform signatures before installing |
| Windows per-user NSIS | Verify next-launch behavior without UAC; do not assume per-machine installs are silent |
| Windows session ending | Verify shutdown/restart/logoff does not launch unsafe on-quit installation; NSIS is not assumed atomic |
| macOS Squirrel staging | Verify native preparation, quit/relaunch replacement, signing, notarization, and both architectures |
| Metadata and security defaults | Inspect modern `files[]`, legacy `path`/`sha512` consumers, `sha2` retirement, and NSIS Web Installer defaults |
| Build-tool migration | Verify Node engine requirements, including the candidate 22.12 floor, native ESM, configuration, signing hooks, and publisher compatibility |
| Distributed old clients | Exercise their real feeds and payloads before changing metadata; do not infer compatibility from dependency version alone |

### Multiple pending versions

The candidate policy follows the latest eligible version without exposing a package collection to users. Own only one effective download/install target; temporary files do not promise an older installable fallback.

| Situation | Candidate behavior |
|---|---|
| A downloading when C is found | Do not repeatedly cancel A; handle newer candidates in a subsequent check |
| A ready, automatic setting enabled, C found | Prepare C and replace A's install entry with C progress |
| A ready, automatic setting disabled, C found | Show C; start its download only on user action |
| D appears during C download | Do not interrupt C; consider D later |
| Installation and task shutdown approved | Lock the chosen target against background replacement |
| C preparation fails after replacing A | Keep running the installed app, show error/retry, and do not promise installation of A |

Reconfirm platform support before abandoning a prepared target. Cache identity includes artifact metadata and hashes, not just a version string. Replacement after readiness is application coordination, not an assumed automatic capability of the updater library. It must be separately tested with channel changes, new releases, retries, and installer handoff.

### Cache invalidation and revocation

Reuse verified complete cache; do not promise partial-download resumption or preservation of an older installable package. Publish a higher fix for a defective release and update the feed. Metadata mismatch may invalidate some cache but is not strict revocation: already staged or installing artifacts may still apply. Continuing to run the installed app after failure is different from installing an older cache. Do not implement an independent artifact revocation list or pre-install revocation interception. The mandatory API decides whether upgrading is required, not which updater artifact to install or invalidate.

## Alternatives considered

**Enable every extension in the first release.** This adds unqualified installer and release paths before a Desktop distribution exists. Fixed Nightly and explicit installation provide the smaller initial scope.

**Treat changing a setting as cancellation.** Native staging may already own installation. Product wording and state transitions must reflect verified cancellation capability.

## Acceptance criteria

- Approve each extension independently; retain initial behavior until its acceptance criteria are satisfied.
- Test independent revision ordering and all consumers of split versions before releasing `.dsk.N`.
- Verify both channel publication, persistent selection, stale-response rejection, cache revalidation, and no downgrades.
- Measure real Windows per-user and macOS x64/arm64 update preparation, termination, next launch, native staging, profile reconciliation, and Host startup.
- Prove the disabled setting's effect on active and staged updates before promising immediate revocation.
- Cover A-to-C replacement, C failure, intervening D, channel switching, and locked installation targets.
- Preserve task approval, honest progress, silent automatic-check failures, and recovery to the usable installed app; do not block normal startup on network failure.

## Risks

Native installer ownership limits cancellation and replacement. Faster startup cannot be guaranteed from API availability alone, and metadata replacement is not a universal rollback mechanism. Library API candidates, security defaults, build-tool engines, and old-client compatibility need release-specific verification; none is a verified product capability merely because it appears in this proposal.
