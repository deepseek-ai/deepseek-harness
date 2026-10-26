/** Identity of a Windows packaging run and its independent build root. */
export interface WindowsBuildWorkspaceOptions {
  sourceDirectory: string
  buildRoot: string
  runId: string
  runAttempt: string
  sourceSha: string
}
/**
 * Clone the clean selected commit into a new run-owned directory.
 * @param options - Original checkout and Actions run identity.
 * @returns Checkout and temporary directory owned by this run.
 */
export function prepareWindowsBuildWorkspace(options: WindowsBuildWorkspaceOptions): { directory: string; temporaryDirectory: string }
/**
 * Remove the directory only when its ownership record matches the run.
 * @param options - Original checkout and Actions run identity.
 */
export function removeWindowsBuildWorkspace(options: WindowsBuildWorkspaceOptions): void
