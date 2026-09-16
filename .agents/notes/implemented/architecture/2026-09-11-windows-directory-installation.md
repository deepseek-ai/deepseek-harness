# Agent Note: Replace Windows application directories after staging

Status: implemented

English | [中文](2026-09-11-windows-directory-installation.zh.md)

## Problem

The Desktop distribution contains thousands of small files. Extracting to the temporary directory, copying every file to the installation, and deleting the temporary tree repeats filesystem work. A 616,701,792-byte, 11,735-file payload took 101.235, 79.203, and 114.391 seconds through those three phases on Windows; copying accounted for 70.296, 56.688, and 85.281 seconds. These component measurements exclude old-version removal, registration, startup, and cache clearing.

## Decision

The [NSIS adapter](../../../../apps/desktop/scripts/windows-directory-installer.mjs) retains electron-builder's installer, signed uninstaller generation, registration, shortcuts, and updater cache. It stages the complete new application beside the destination before stopping the old application. The [directory transaction](../../../../apps/desktop/scripts/installer-directories.nsh) renames the old directory to a unique backup, renames the new directory to the destination, and removes the backup before launch. Both renames stay on the destination volume. This replaces the copy-based installation decision in the [packaging note](2026-08-25-electron-desktop-packaging-and-updates.md).

The installer embeds its pinned 7-Zip command-line tool, signs its private copy for signed releases, and includes its license texts. Windows records the copied runtime inventory after its executable resources have been signed. A nonzero extraction exit leaves the old application intact. Explicit cleanup before upstream installer exits also covers silent cancellation. Same-path upgrades bypass the old uninstaller so it cannot delete the rollback copy or registration prematurely. Different-path and installation-scope migrations retain electron-builder's old-uninstaller behavior; the directory rollback does not undo those uninstall operations.

## Consequences

Directory cleanup, including uninstallation, uses extended-length Windows paths for deeply nested dependencies and backup suffixes. Failed promotion attempts restore the renamed old directory. If another process prevents restoration, the complete backup remains available. Abrupt process termination or power loss can leave staging or backup directories; the installer does not claim crash-atomic replacement across two renames. The transaction changes installation files, not the external Desktop plugin profile or product data.

## Alternatives considered

- **Direct extraction over the running installation.** The existing locked-file probe demonstrates that `Nsis7z::Extract` can retain an old file without setting the NSIS error flag. Staging through a tool with an exit status avoids accepting a mixed installation.
- **Delete the old version before extraction.** A corrupt archive or failed write would remove the only usable version before replacement is ready.
- **Put the Host in ASAR.** Native modules, package resolution, and subprocess paths require separate qualification; directory replacement preserves the resource layout.

## Verification

The [native directory smoke](../../../../apps/desktop/scripts/smoke-installer-directories.ps1) calls production macros against private directories. It covers fresh installation, obsolete-file removal on upgrade, locked-directory failure, restoration after the second rename fails, corrupt archives, and cancellation cleanup. Template tests pin staging before shutdown and promotion before registration. The signed 0.1.5-rc.2 installer passed fresh installation, same-path upgrade with obsolete-file removal, locked-file failure preserving the old installation, installation-location migration, and complete uninstallation on Windows. Each installation check compared all 11,736 payload files against the packaged tree and verified executable/uninstaller signatures and registration. The installed runtime passed native dependency, Web frontend, external plugin route, and actual Electron window startup/exit checks. The final installer sample took 38.0 seconds for fresh installation and 27.5 seconds for same-path upgrade, excluding verification and launch; caches were not cleared. These are full-installer observations, separate from the component baseline above. Hosted updater download and upgrades from historical published releases remain release qualification.
