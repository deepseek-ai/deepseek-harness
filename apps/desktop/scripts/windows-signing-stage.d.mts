/** Stage-wide ownership is independent of the retained hardware-attempt interlock. */
export interface WindowsSigningStageOptions {
  stage: string
  record: (event: object) => void
  signal?: AbortSignal
  /** Test-only storage isolates independent processes from the real account's signing state. */
  stateDirectory?: string
}

/**
 * Queue one complete signing or cache-maintenance stage under the account's exclusive file handle.
 * @param options Audit sink, optional wait cancellation and isolated test storage.
 * @param operation Stage that awaits all owned children before settling.
 * @returns The stage result, after releasing the handle; acquisition errors never run the stage.
 */
export function withWindowsSigningStage<T>(options: WindowsSigningStageOptions, operation: () => Promise<T>): Promise<T>
