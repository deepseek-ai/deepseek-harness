# Agent Note: Windows uninstall retains the Harness home

Status: implemented

English | [中文](2026-09-08-desktop-uninstall-preserve-dsh-home.zh.md)

## Problem

Desktop and CLI share conversations, credentials, settings and plugins in the Harness home. Electron keeps browser storage and caches under `%APPDATA%`, and the updater keeps downloaded installers under `%LOCALAPPDATA%`; the upstream NSIS template leaves both behind unless a command-line flag is passed. Users who uninstall expect the application to leave no residue, while users who reinstall expect their conversations back.

## Decision

Windows uninstallation removes the Electron user-data directory, the `%APPDATA%` product directory and the updater cache together with the application, and never touches the Harness home. This is the 2026-09-08 proposal in amended form: Windows only, without the installed-artifact inventory programme, and without a user choice. No custom uninstaller page exists; silent uninstallation removes the same data. An uninstaller started with `--updated` or `/KEEP_APP_DATA` retains it, which covers electron-builder's in-place update and its replacement of an older installation from another directory, so updates keep UI preferences. A `DSH_HOME` published as a Windows environment variable protects every target overlapping it; the native helper cannot see a home configured only in a shell profile.

Electron derives its user-data directory from the scoped package name, so the removal targets `%APPDATA%\@deepseek-ai\dsh-desktop` and afterwards removes ordinary empty parents below `%APPDATA%`, never a linked or populated scope directory. Removal runs through the native helper in `window-frame.dll`, which rejects protected Windows folders and paths overlapping the installation or the protected home, holds directory handles with listing access during traversal so the directory cannot be renamed or replaced underneath it, unlinks reparse points without entering their targets, clears the read-only attribute, and keeps deleting siblings after a locked file. It requires a fixed local drive and leaves a linked root or ancestor in place. A failure leaves residue and does not stop or report on uninstallation; the uninstaller has no custom copy.

Installation also records `InstallLocation` on the Windows uninstall entry as standard inventory metadata. Launching the uninstaller directly from the Start menu context menu is unavailable to Win32 installers on Windows 11; only MSIX packages uninstall from there, so that request is outside this decision.

## Alternatives considered

**Opt-in removal on a custom uninstaller page, including the desktop profile and the whole home.** The desktop profile, sessions and credentials belong to the home shared with the CLI and stay in place for reinstallation; the remaining Electron data holds only UI preferences and caches, which does not justify a choice the user must understand, a recorded home path for the uninstaller, and a bilingual native dialog.

**Delete the whole home when desktop is the only profile.** Profile presence does not establish whether shared data is needed by CLI or a future reinstall.

**Leave Electron data in place, matching the upstream default.** Chromium caches grow to hundreds of megabytes and are the residue users report after uninstalling.

**Use electron-builder's `deleteAppDataOnUninstall`.** The upstream `RMDir /r` follows no ownership rules, ignores long paths and enters linked directories; the native helper owns removal instead.

**Establish the cleanup inventory by observing disposable accounts across install, update and uninstall.** The three roots follow from Electron's `userData` derivation and electron-builder's updater cache name, both fixed by configuration; observation would confirm what the configuration already states.

## Deferred

macOS cleanup (a signed helper behind an **Uninstall and keep Harness data** action, since drag-to-Trash cannot run application code) remains open under #3540 and is not decided here.

## Consequences

Reinstallation restores conversations, settings and plugins but not UI layout preferences. The desktop profile under the home remains with its packages and lock files. Other historical homes and user projects are not discovered or deleted. Roaming profiles on network or removable drives are left in place.

Qualification uses isolated product identities with a per-run scoped package name. Source regressions cover template adaptation; the native remover regression covers refused roots, the protected home, rename blocking while pinned, read-only and locked files, and empty-parent removal; the uninstaller fixtures cover interactive, silent, `--updated`, `/KEEP_APP_DATA`, and a `DSH_HOME` inside the Electron directory, with a junction to an external project inside the removed data. The standard uninstaller pages render correctly at 200% scaling on the development host.
