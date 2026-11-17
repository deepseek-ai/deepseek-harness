/** Types for the pinned NSIS directory installation adapter. */

/**
 * Replace payload installation while preserving registration and uninstall UI.
 * @param source Pinned electron-builder installSection.nsh contents.
 * @returns Section with staged directory replacement.
 */
export function directoryInstallSection(source: string): string

/**
 * Clean staged directories on upstream Quit paths, including silent installers.
 * @param source Pinned NSIS helper source.
 * @returns Helper with cleanup before installer exits.
 */
export function directoryInstallerExits(source: string): string

/**
 * Preserve data but clean old registrations when replacing another installation directory.
 * @param source Pinned NSIS installUtil.nsh contents.
 * @returns Helper reserving --updated for replacement at the same path.
 */
export function directoryInstallUtil(source: string): string

/**
 * Retain the original uninstall directory, reject another installation owner, and use native data cleanup.
 * @param source - Pinned upstream uninstaller source.
 * @returns Uninstaller with long-path removal and upgrade rollback, without upstream RMDir data removal.
 */
export function directoryUninstaller(source: string): string

/** Install the build-only adapter while retaining signed uninstaller generation. */
export function installWindowsDirectoryInstaller(): void
