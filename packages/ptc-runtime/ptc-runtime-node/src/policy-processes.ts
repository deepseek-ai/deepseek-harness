/** Node PTC process invalidation after a committed Session file-policy change. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

interface Process {
  sessionId: SessionId
  mode: SandboxMode
  release: () => Promise<void>
  invalidated: boolean
  cleanup?: Promise<void>
}

/** Owns asynchronous process cleanup without delaying permission setters. */
export class PolicyProcesses {
  private readonly processes = new Set<Process>()

  /**
   * Begin cleanup on policy changes, even when no subsequent program runs.
   * @param ctx - Node provider lifecycle and Session services.
   */
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'sandbox/mode') return
      for (const process of this.processes) {
        if (process.sessionId !== session.id || process.mode === event.data.mode) continue
        process.invalidated = true
        void this.release(process).catch((error: unknown) => { ctx.logger.warn(error) })
      }
    }, { global: true })
    ctx.effect(() => async () => {
      await this.settle([...this.processes])
    }, 'Node PTC policy cleanup')
  }

  /**
   * Track an admitted call or retained process until its owner confirms cleanup.
   * @param policy - Resolved process policy, including an optional Session identity.
   * @param release - Idempotent cancellation and awaited cleanup.
   * @returns Removal after successful process cleanup.
   */
  register(policy: SandboxExecutionPolicy, release: () => Promise<void>): () => void {
    if (policy.sessionId === undefined) return () => {}
    const session = this.ctx.get('sessions')?.get(policy.sessionId)
    const process: Process = {
      sessionId: policy.sessionId,
      mode: session === undefined ? policy.mode : this.ctx.sandboxPolicy.resolve({ session }).mode,
      release,
      invalidated: false,
    }
    this.processes.add(process)
    return () => { this.processes.delete(process) }
  }

  /**
   * Wait for invalidated processes before admitting another program.
   * @param sessionId - Session carried by the resolved policy.
   * @returns Completion after prior cleanup; a failure rejects and remains retryable.
   */
  async wait(sessionId: SessionId | undefined): Promise<void> {
    await this.settle([...this.processes].filter(process => process.sessionId === sessionId && process.invalidated))
  }

  private release(process: Process): Promise<void> {
    if (process.cleanup !== undefined) return process.cleanup
    process.cleanup = process.release().then(() => { this.processes.delete(process) }, (error: unknown) => {
      delete process.cleanup
      throw error
    })
    return process.cleanup
  }

  private async settle(processes: Process[]): Promise<void> {
    const results = await Promise.allSettled(processes.map(process => this.release(process)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
