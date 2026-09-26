/**
 * Host-native command execution and path-opening utilities.
 * @module @deepseek-ai/dsh-native-command
 */

export { runNativeCommand } from './runner.ts'
export type { NativeCommandRunner } from './runner.ts'
export {
  canOpenNativePath,
  nativeFileManager,
  revealNativePath,
  openNativePath,
  openNativeAssociatedPath,
  openNativeTextFile,
} from './path-opener.ts'
export type {
  NativeFileManager,
  PathOpenerInternals,
  PathOpenerRunner,
} from './path-opener.ts'

export { nativeFileApplications, openNativeFileApplication } from './file-applications.ts'
export type { NativeFileApplication } from './types.ts'

export { desktopEntryFields, desktopDataDirectories, desktopApplicationIcon } from './desktop-entry.ts'
