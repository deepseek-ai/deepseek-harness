/** Import cancellation belongs to an evaluation, not to the imported module's cached failure. */
export class ImportEvaluationEndedError extends Error {
  /** Whether a later evaluation can reuse this process after the cancelled import. */
  readonly retainsState: boolean

  constructor(retainsState: boolean, pending = false) {
    super(pending ? 'PTC evaluation ended before its import completed'
      : 'PTC evaluation has ended; import modules from a new run_code evaluation')
    this.retainsState = retainsState
  }
}
