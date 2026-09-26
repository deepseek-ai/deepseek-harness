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
 * Keep user-data removal in the native helper, which refuses unsafe roots and never follows links.
 * @param source - Pinned upstream uninstaller source.
 * @returns Uninstaller with long-path application removal and no upstream RMDir data removal.
 */
export function directoryUninstaller(source: string): string

/** Install the build-only adapter while retaining signed uninstaller generation. */
export function installWindowsDirectoryInstaller(): void
