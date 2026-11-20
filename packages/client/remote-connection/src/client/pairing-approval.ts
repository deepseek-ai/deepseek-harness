/** Owner decisions and their shell-wide notices survive a settings view closing. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-remote-connection/remote'
import type { PairingDecision, PairingDecisionResult, PairingRequestId } from '../types.ts'

/** Mutation state shared by approval controls and the persistent notice. */
export interface ApprovalState {
  readonly available: boolean
  readonly busy: boolean
  readonly notice: 'approved' | 'denied' | 'unavailable' | 'failed' | null
  readonly sequence: number
}

/** Serializes owner decisions and ignores results after access is withdrawn. */
export class PairingApproval {
  /** Framework-observed operation state; it contains no applicant credentials. */
  readonly state = createSnapshotStore<ApprovalState>({ available: false, busy: false, notice: null, sequence: 0 })
  private controller: AbortController | undefined

  /**
   * @param remote - generated owner-only pairing mutations.
   * @param confirmed - removes a confirmed request from active resources before resolving; never rejects.
   */
  constructor(
    private readonly remote: Pick<Context['remote']['remoteConnection'], 'decidePairing'>,
    private readonly confirmed: (id: PairingRequestId) => Promise<void>,
  ) {}

  /** Activate approval controls for the current owner-access grant. */
  activate(): void {
    this.controller = new AbortController()
    this.state.set({ ...this.state.getSnapshot(), available: true })
  }

  /**
   * Submit the owner decision and update active lists before announcing its confirmed outcome.
   * An unknown outcome retains the request for reconciliation.
   * @param id - selected request.
   * @param decision - allow or deny after comparing the displayed code.
   * @returns after the decision settles or access is withdrawn.
   */
  async decide(id: PairingRequestId, decision: PairingDecision): Promise<void> {
    const controller = this.controller
    if (controller === undefined || this.state.getSnapshot().busy) return
    const aborted = (): boolean => controller.signal.aborted
    this.state.set({ ...this.state.getSnapshot(), busy: true, notice: null })
    let notice: ApprovalState['notice'] = 'failed'
    let result: RemoteResult<PairingDecisionResult> | undefined
    try {
      result = await this.remote.decidePairing(id, decision, controller.signal)
    } catch (_requestFailure) {
      // The shell notice reports an unknown decision outcome; polling retains the actual row state.
    }
    if (result?.ok) notice = result.value
    if (aborted()) return
    if (notice !== 'failed') await this.confirmed(id)
    if (aborted()) return
    this.state.set({ available: true, busy: false, notice, sequence: this.state.getSnapshot().sequence + 1 })
  }

  /** Dismiss only the notice currently displayed by the shell. */
  dismiss(): void { this.state.set({ ...this.state.getSnapshot(), notice: null }) }

  /** Abort the current operation and discard state when owner access ends. */
  dispose(): void {
    this.controller?.abort()
    this.controller = undefined
    this.state.set({ available: false, busy: false, notice: null, sequence: this.state.getSnapshot().sequence })
  }
}
