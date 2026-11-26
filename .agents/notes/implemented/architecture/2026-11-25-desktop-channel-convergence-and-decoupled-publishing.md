# Agent Note: Converge Desktop update channels on stable and decouple target publication

Status: implemented

English | [中文](2026-11-25-desktop-channel-convergence-and-decoupled-publishing.zh.md)

## Problem

Early Desktop builds embedded `nightly` as the default update channel, wrote unversioned `userData/desktop/settings.json` files without distinguishing implicit defaults from deliberate developer opt-in, exposed **Update channel** directly in General Settings, and bound CI publication and rollout to the single channel embedded at build time. Shipping aggressive experimental builds on `nightly` under those rules would push experimental payloads to ordinary installations whose packaged default or unversioned preference pointed at `nightly`, while delivering the same signed release to both `stable` and `nightly` required building and notarizing two separate packages.

Converging ordinary users onto `stable` while keeping `nightly` usable for opt-in testing requires separating the build-embedded channel marker, the target publication channel, the client's unlocked selection state, and the feed metadata headers that allow an update gateway to distinguish locked legacy requests from explicit opt-in requests.

## Decision

Keep two update channels (`stable` and `nightly`). Packaging defaults `DSH_DESKTOP_UPDATE_CHANNEL` to `stable` across local builds and CI workflows. `Publish Desktop · COS` and `Publish Desktop · Rollout & Website` select target channels (`stable`, `nightly`, or both) and website installer upload through independent boolean checkboxes on one retained signed package, writing per-channel locks and audit records and creating `desktop-v<version>` once per production source commit. Website-only rollouts upload and purge the retained production installer without requiring prior channel feed publication, and `rollback-desktop-channel.ts` reconstructs its target destination from `DESKTOP_PUBLISH_ROUTE.channel` rather than `manifest.source.channel`.

`userData/desktop/settings.json` carries `"version": "1"`. Startup initialization writes `"version": "1"` on first launch and migrates valid unversioned documents in place to `"version": "1"`, removing any unversioned `updates.channelUnlocked` field and resetting an unversioned `"nightly"` channel to `"stable"` without overwriting malformed JSON, invalid structure, unsupported `version` values, or invalid field values. Whenever `"version": "1"` and `updates.channelUnlocked: true` are not both present, the client hides **Update channel** (unless a configuration error needs recovery) and locks the effective runtime channel to `stable` regardless of packaged `dshDesktopUpdateChannel` or un-unlocked file fields. Clicking **Current version** five times in Desktop **Settings → General** opens a warning confirmation dialog with initial focus on **Cancel**; confirming writes `"version": "1"`, `updates.channel: "nightly"`, and `updates.channelUnlocked: true`, switches immediately to `nightly`, and keeps **Update channel** visible across subsequent switches back to `stable`.

`DesktopUpdateProvider` subclasses `electron-updater`'s `GenericProvider` and attaches non-secret source headers (`x-dsh-config-version`, `x-client-update-channel`, `x-client-channel-source`, `x-client-version`, `x-client-bundled-dsh-version`, `x-client-platform`, `x-client-arch`, and `x-client-device-id` from `<userData>/.updaterId`) exclusively on `.yml` feed requests while keeping `.zip`, `.exe`, and `.blockmap` payload downloads header-free.

## Channel vocabulary and feed routing

Packaged channel markers (`dshDesktopUpdateChannel`), target publication channels (`stable` / `nightly`), effective runtime channels (`stable` when locked; user-selected when unlocked), and public feed endpoints (`stable[-mac].yml` / `nightly[-mac].yml`) are independent: a build marked `stable` can publish to `nightly`, and `stable` feeds can carry RC or alpha prerelease versions. Because automatic downgrade remains disabled, installations already running a higher prerelease stay on their installed version until a higher release reaches `stable` and then migrate on upgrade.

| Feed endpoint | Request condition | Served metadata |
|---|---|---|
| `stable[-mac].yml` | Any request | Current `stable` channel metadata |
| `nightly[-mac].yml` | Missing `x-dsh-config-version: 1` or `x-client-channel-source: explicit` | Current `stable` channel metadata |
| `nightly[-mac].yml` | Both `x-dsh-config-version: 1` and `x-client-channel-source: explicit` | Current `nightly` channel metadata |

Un-unlocked `nightly[-mac].yml` requests receive the live same-platform `stable` feed object rather than a third frozen baseline YAML, so `stable` publications, staged rollouts, and rollbacks apply uniformly to `stable[-mac].yml` and un-unlocked `nightly[-mac].yml` callers while CDN and gateway caches separate locked and unlocked responses.

## Deferred

- **External feed gateway routing (#9204)**: Edge or update-service routing for `/dsh-desk/feeds/<target>/<feed>.yml` enforces the header table above outside this repository before `nightly` stops mirroring `stable` builds; client startup, migration, and channel switching do not depend on gateway cutover timing.
- **Website installer packaged-channel restriction (#9204)**: `desktop-website-installer.ts` accepts either `manifest.source.channel` value while retained `nightly`-marked packages age out, then tightens validation to require `manifest.source.channel === 'stable'`.
- **Account-scoped rollout headers (#9204)**: Reporting an authenticated user identifier header on feed requests remains separate work until a dynamic update distribution backend consumes it.

## Alternatives considered

**Add a third `alpha` update channel.** A third channel multiplies CI checkboxes, feed files, binary prefixes, and user-facing labels without solving unversioned legacy clients, whereas two channels (`stable` for general delivery including RCs, `nightly` behind explicit 5-click unlock) cover both release streams cleanly.

**Assign separate settings versions (`"1"` and `"2"`) to migrated and newly created files.** Once unversioned `nightly` preferences reset to `stable` during migration, migrated and newly initialized locked files have identical runtime semantics (`version: "1"`, locked to `stable` until `channelUnlocked: true`), so a second schema generation adds branching without behavioral distinction.

**Build separate signed installers per target channel.** Rebuilding and re-notarizing identical source commits solely to flip `dshDesktopUpdateChannel` doubles macOS notarization and Windows EV signing work and prevents promoting a verified build across channels; decoupling target publication channels from the retained package's embedded marker eliminates duplicate builds.

**Attach source headers to every updater HTTP request.** Putting custom client headers onto `updater.requestHeaders` forwards them to COS/CDN `.zip`, `.exe`, and `.blockmap` range downloads, risking cache fragmentation and cross-origin header rejections; scoping headers to `.yml` requests inside `DesktopUpdateProvider.httpRequest` keeps binary delivery unchanged.

**Return HTTP `204 No Content` when no update applies.** `electron-updater` 6.8.9 `GenericProvider` parses `.yml` bodies unconditionally and treats empty `204` responses as invalid update metadata errors; feeds instead return valid YAML whose version is less than or equal to the client's installed version when no upgrade applies.

## Consequences

- Ordinary installations and migrated legacy installations check `stable` and never display **Update channel** unless a user confirms the 5-click warning on **Current version** or a configuration error requires recovery.
- Legacy installations upgrade to `"version": "1"` as higher releases become available on their current feed without enabling automatic downgrades; keeping unversioned migration logic in `DesktopSettingsFile.initialize()` covers installations that skip intermediate releases.
- One signed and notarized package run can publish to `stable`, `nightly`, and the fixed website download URL independently or together, and channel rollback targets the published channel route accurately even when `manifest.source.channel` differs.
- Every `.yml` check carries explicit versioned source metadata (`x-dsh-config-version: 1` and `x-client-channel-source: explicit` after unlock) so an external gateway can isolate `nightly` experiments from un-unlocked `nightly[-mac].yml` callers without changing binary download caching.
- `userData/desktop/settings.json` validation rejects unsupported `version` strings loudly instead of silently overwriting newer or corrupted configuration files.
