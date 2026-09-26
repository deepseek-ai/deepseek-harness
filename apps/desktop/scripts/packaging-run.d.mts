/**
 * Persist one credential-free packaging event before its operation.
 * @param directory Private run directory.
 * @param event Whitelisted fields, excluding arguments and environments.
 * @returns Nothing.
 */
export function recordPackagingEvent(directory: string, event: object): void
/**
 * Publish a fatal marker that stops the supervised stage tree.
 * @param directory Private run directory.
 * @param reason Credential-free failure category.
 * @returns Nothing.
 */
export function failPackagingRun(directory: string, reason: string): void
/**
 * Redact inherited secret values across arbitrary output chunk boundaries.
 * @param secrets Exact credential values to remove.
 * @param emit Redacted output sink.
 * @returns A UTF-8 stream consumer that flushes its suffix on end.
 */
export function packagingOutputRedactor(secrets: readonly string[], emit: (text: string) => void): {
  write(chunk: Buffer): void
  end(): void
}
/**
 * Allocate retained evidence and supervise sequential child-process stages.
 * @param root Parent directory for retained records.
 * @param metadata Public target/version metadata only.
 * @param settings Opt-in parallel stages and additional credentials to redact.
 * @returns A run that blocks later stages after failure and awaits owned process termination.
 */
export function createPackagingRun(root: string, metadata: object, settings?: { parallel?: boolean; secrets?: readonly string[] }): {
  directory: string
  run(stage: string, executable: string, args: readonly string[], options: {
    cwd: string
    env: NodeJS.ProcessEnv
    /** Optional stage deadline; timeout fails the run even if the child reports exit zero. */
    timeoutMs?: number
  }): Promise<void>
  finish(success: boolean): void
}
