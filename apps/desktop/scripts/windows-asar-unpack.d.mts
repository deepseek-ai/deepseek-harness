import type { BeforePackContext } from 'app-builder-lib'

/**
 * Install source-relative PE patterns in the active builder configuration.
 * @param context Active builder configuration and cleanup owner.
 * @param sourceRoot Verified prepared dsh directory; external sources receive a build-owned staging copy.
 * @returns PE paths relative to the original prepared directory.
 */
export function prepareWindowsAsarUnpack(context: BeforePackContext, sourceRoot: string): Promise<string[]>

/**
 * Reject inline, absent, linked, or changed PE files in the assembled application.
 * @param sourceRoot Original signed and sealed dsh directory.
 * @param resourcesDir Assembled application resources directory.
 * @param files PE paths returned by prepareWindowsAsarUnpack.
 * @returns Resolves after every PE has an unpacked ASAR entry and identical bytes.
 */
export function verifyWindowsAsarUnpack(sourceRoot: string, resourcesDir: string, files: string[]): Promise<void>
