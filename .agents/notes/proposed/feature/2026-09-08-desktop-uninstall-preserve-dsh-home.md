# Agent Note: Uninstall Desktop while preserving the Harness home

Status: proposed

English | [中文](2026-09-08-desktop-uninstall-preserve-dsh-home.zh.md)

## Problem

Users need Desktop uninstallation to remove its application files and external application state while retaining the complete Harness home. Removing an application directory does not account for browser storage, cached installers, or native updater state. Browser storage also contains unsent drafts and UI preferences, so removing it changes more than disk cache usage.

The [packaging configuration](../../../../apps/desktop/electron-builder.config.mjs), [desktop entry](../../../../apps/desktop/src/main.ts), and [update coordinator](../../../../apps/desktop/src/update-coordinator.ts) are the inspection inputs. Source inspection identifies cleanup candidates; installed-artifact observation must establish the complete supported inventory before implementation is accepted. No uninstall experiment has yet established an exhaustive Windows or macOS inventory.

## Proposal

Provide an uninstall operation whose successful result leaves the complete default `~/.dsh` and any configured `DSH_HOME` intact, removes Desktop-owned files outside those homes, and removes the selected application installation. Preserve plugin files, package-manager state, sessions, settings, and credentials within the retained homes. Do not launch or repair the Desktop profile during cleanup.

Windows Control Panel and Settings uninstallation will run this operation through NSIS. macOS will expose a localized **Uninstall and keep Harness data** action backed by a signed cleanup helper. Finder drag-to-Trash alone cannot invoke this operation; document that limitation and provide the same helper as a signed standalone uninstaller for users who already removed the application. A plain drag operation must not be advertised as complete cleanup.

User-created projects, separately installed CLI software, user-saved downloads and exports, arbitrary third-party plugin/tool outputs, and OS-maintained audit/security records are outside application cleanup. Do not search the disk for names containing `dsh` or `DeepSeek`. The success promise concerns application-owned state, not deletion of user work or erasure of OS history.

### 1. Establish ownership and actual paths

Use disposable Windows and macOS accounts to capture filesystem and relevant registration differences across installation, first launch, draft editing, plugin installation, update download, update installation, and uninstallation. Inspect the packaged `package.json`, macOS `Info.plist`, `app-update.yml`, and runtime `app.getPath()` values. Include failed/interrupted updates. Record discovered owners and cleanup locations beside the desktop implementation, with fixture evidence rather than a dynamically accepted list of arbitrary absolute paths.

| Candidate | Windows | macOS | Required treatment |
|---|---|---|---|
| Electron user/session data | Runtime `userData` and `sessionData`, normally under `%APPDATA%` | Runtime `userData` and `sessionData`, normally under `~/Library/Application Support` | Remove browser storage, preferences, cache, and `.updaterId`; disclose loss of unsent drafts. |
| Installer/update cache | `%LOCALAPPDATA%/<updaterCacheDirName>` | `~/Library/Caches/<updaterCacheDirName>` | Remove cached installers, ZIPs, blockmaps, pending downloads, and metadata; include the NSIS installer copy created during installation. |
| Native updater state | Any additional paths proved by the installed NSIS flow | App-specific Squirrel and `<appId>.ShipIt` cache/state/log directories | Stop the owned updater job and remove its remaining state after it exits. |
| Other native application state | App-owned files/registrations proved by observation | App-specific preferences, saved state, logs, or diagnostics proved by observation | Add only established ownership; an Electron path API alone does not prove a file is created. |
| Application and integration | Installation directory, installed shortcuts, installation/uninstallation registration | Selected `.app` and helper-owned integration | Use the native uninstall flow and validate the selected installation identity. |
| Harness home | Default `.dsh` and configured `DSH_HOME` | Default `.dsh` and configured `DSH_HOME` | Preserve the complete trees, including Desktop-only subdirectories. |

Create one small application-owned cleanup inventory, consumed by packaging and cleanup implementations. Derive identity and updater cache names from the release metadata. The same inventory must explain test expectations. Verify any existing distributed release before adding a legacy path; do not introduce migrations for unpublished development layouts.

### 2. Implement shared preservation and cleanup rules

Resolve targets for the installation owner, not the elevated administrator's home. Preserve the default home even when an override is active, and protect configured homes recorded by Desktop as well as the current override. Validate any persisted record at this file boundary; it may protect a location but may never authorize deletion of an arbitrary location.

Reject deletion of a protected home, its ancestor, or its contents. Account for case-insensitive paths, symlinks, Windows junctions/reparse points, and path replacement during cleanup. Do not follow a link into another tree. An installation or cache location containing a protected home is a conflict: stop before recursive removal and report the remaining path. Keep these checks in the actual native removal path, not only in a preview.

Stop new windows, updates, and plugin mutations; finish or safely stop active operations; stop the owned Host/process tree; then wait for exit and released files before removal. Do not kill processes solely by executable name. Perform an ownership/path preflight before destructive steps. Treat missing targets as success, and support retry after partial cleanup. Report locked or inaccessible paths explicitly; a queued reboot deletion or partial result is not complete cleanup.

Keep `.dsh` free of cleanup journals or receipts. Any temporary helper/state must live in a private temporary directory, avoid executable-search-path lookup, and have a bounded self-cleanup path. Verify that cleanup does not recreate Electron user data after it has been removed. Cancellation before removal leaves the installation usable.

### 3. Windows implementation

Keep the assisted NSIS installer (`oneClick: false`). Extend its custom uninstall hooks and removal ordering rather than replacing the complete installer. Do not depend on `deleteAppDataOnUninstall` to cover updater caches, custom paths, or protected homes. Apply preservation checks before the default installation-directory removal as well as before extra cleanup.

Normal Control Panel, Settings, direct uninstaller, and silent uninstall must share the same cleanup rules and useful exit status. Automatic update/replacement must skip destructive user-state cleanup; validate the actual electron-updater flags and NSIS update condition with a real upgrade. A failed upgrade must retain browser data and `.dsh`.

Per-user uninstall cleans that installation owner's Desktop state. All-user uninstall must identify each affected local user profile and clean its Desktop-owned state while preserving every Harness home, under the required Windows privileges. Do not resolve all users through one `$APPDATA` expansion. If an affected profile is inaccessible or another installation still owns a shared path, report that condition instead of deleting shared state or claiming complete cleanup. Include this distinction in the uninstall UI and silent result.

Let NSIS remove the application, its installed shortcuts, and installation registration. Explicitly remove the application-owned cache/user-data inventory, including the cached copy of the installer. Preserve existing signing requirements for installer, uninstaller, and any added executable. Add a build-time check that custom hooks and the cleanup inventory are actually packaged.

### 4. macOS implementation

Add the localized uninstall action to the Electron-owned menu/recovery UI so it remains available when the Host cannot boot. Before proceeding, show that `.dsh` is retained and unsent drafts/UI preferences outside it are deleted. Complete cleanup must include removal of the selected application bundle; if only moving it to Trash, report that disk space remains until Trash is emptied.

Use a signed helper that can finish after Electron and the Host exit. Verify bundle identity and the selected path before removing it; handle `/Applications`, `~/Applications`, and a relocated writable bundle. Obtain authorization only for paths requiring it. Coordinate with Squirrel/ShipIt, remove only this application's updater jobs/state, and delete the discovered external application directories and preferences. Include helper staging files in completion verification.

Package the same cleanup implementation as a signed, notarized standalone uninstaller for the already-deleted-app case. It must not require the removed bundle or a working `.dsh` profile. A read-only mounted DMG is not an installed writable application; provide an actionable result rather than attempting to alter it. For a shared application installation, account for affected users and privileges as on Windows; report any state that could not be cleaned.

### 5. Verification and documentation

Add focused tests for target ownership, protected-home overlap, link/reparse-point traversal, identity mismatch, arbitrary-path rejection, custom/absent `DSH_HOME`, another installation sharing data, and inaccessible profiles. Exercise cancellation, active Host/update/plugin processes, interruption between removals, retries, and self-cleanup without using the developer's real home. Follow the [CI reliability workflow](../../../skills/dsh-ci-test-reliability/SKILL.md) when implementing process and filesystem tests.

Run installed-artifact e2e checks on Windows and both shipped macOS architectures. Cover first installation without updates, one downloaded/installed update, failed update, per-user/shared installation, relocated application, and standalone macOS cleanup after drag deletion. Compare filesystem/registration inventories independently of the uninstaller's success response. Hash retained `.dsh` content after the app and CLI are quiescent and before removal; require identical content, paths, and link entries afterward. Do not require preserved runtime links to resolve after their application target is removed.

Add owner-local expected output for uninstall UI and failure results. Add a keyless recorded-session scenario proving an existing conversation survives uninstall/reinstall; keep purely installer/UI expectations outside the top-level Session tree. Record the required real-server/model GUI GIF for the implementation PR. Update the [Desktop README](../../../../apps/desktop/README.md), its Chinese counterpart, user instructions, locale dictionaries, JSDoc, and this proposal's lifecycle when implementation ships. Select focused checks through [dsh-pre-push-checks](../../../skills/dsh-pre-push-checks/SKILL.md); signed packaging and real OS uninstall evidence are required, not replaceable by unit tests.

## Alternatives considered

**Keep the default uninstallers.** They do not establish removal of application-owned state outside the application directory and therefore do not meet the requested outcome.

**Move all Electron and update data under `.dsh`.** This can simplify file placement but preserves caches and browser state instead of cleaning them, and does not by itself cover Squirrel/native state or existing external files. It is not the cleanup solution proposed here.

**Detect Finder deletion with a permanent background watcher.** This adds a resident component that itself needs removal and cannot reliably cover deletion while it is stopped. Use an explicit uninstall operation.

**Delete `.dsh/desktop` or `.dsh/profiles/desktop`.** These paths contain Desktop-specific state, but the requested retention rule preserves the whole Harness home rather than only conversations.

## Acceptance criteria

- A successful supported uninstall removes the selected application, its owned registrations, and every external application-owned path established by the installed-artifact inventory; no cleanup helper or updater process remains.
- Default and configured Harness homes retain identical content and links after quiescence. User projects and independent CLI installations remain intact.
- Windows Control Panel/Settings and silent uninstall satisfy the same retention rule. An actual automatic upgrade retains browser state and Harness data.
- macOS's explicit and standalone uninstallers satisfy the cleanup rule. Documentation accurately distinguishes them from Finder drag deletion and from merely moving files to Trash.
- Every unremoved owned path is reported with a retry/recovery action. Unavailable privileges, an inaccessible user profile, and shared ownership never produce a false full-success result.
- Fresh install and uninstall/reinstall tests prove no untracked outside-home application state survives and that retained conversations can be reopened. Native OS inventories, not only mocked API calls, establish completion.

## Risks

Deleting browser storage loses unsent drafts and UI preferences. Whole-home preservation deliberately retains Desktop plugins, pnpm state, and possibly dangling links until reinstall repairs them. Custom data paths and shared installations can prevent complete removal without additional privileges or path relocation; the operation must report that limitation rather than violate retention.

OS-owned security/audit history and user-created files cannot be covered by a promise of erasing all traces. The [Desktop packaging decision](../../implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) and [bundled runtime/external plugin decision](../../implemented/architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md) remain independent authorities for packaging and data ownership; this proposal supersedes neither and archives no active note.
