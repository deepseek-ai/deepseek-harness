/**
 * Acquire durable evidence and the shared signing interlock before any hardware operation.
 * @param options Supervised run, target artifact, and test-only isolated state directory.
 * @returns Process evidence and completion callbacks; only success releases the interlock.
 */
export function beginWindowsSigningAttempt(options: {
  runDirectory?: string | undefined
  stateDirectory?: string | undefined
  target: string
}): {
  started(pid: number | null): void
  success(): void
  failure(code: number | string | null, diagnostic: string): void
}
