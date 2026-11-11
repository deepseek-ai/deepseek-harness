/** Routes typed source output to the task service without owning source instances. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { SourceError } from './error.ts'
import type { AutomationSource } from './source.ts'
import type { AutomationCandidate, AutomationTaskId, AutomationTaskReceiver, SourceConnection } from './types.ts'

interface ReceiverRegistration {
  readonly receiver: AutomationTaskReceiver
  readonly pending: Set<Promise<void>>
}

/** Connects source output to stored automation tasks; source-to-source subscriptions need no router. */
export class AutomationTaskRouter extends Service {
  private receiver: ReceiverRegistration | undefined

  constructor(ctx: Context) {
    super(ctx, 'automationTasks')
  }

  /**
   * Install the task service's delivery endpoint as a Cordis-owned effect.
   * @param receiver - Task service responsible for admission, delivery, and durable acknowledgement.
   * @returns Disposer that rejects new deliveries and awaits accepted deliveries before storage can close.
   * @throws SourceError with SOURCE_TASK_RECEIVER_DUPLICATE while another receiver is registered.
   */
  registerReceiver(receiver: AutomationTaskReceiver): () => Promise<void> {
    if (this.receiver !== undefined) {
      throw new SourceError('An automation-task receiver is already registered.', 'SOURCE_TASK_RECEIVER_DUPLICATE')
    }
    const registration: ReceiverRegistration = { receiver, pending: new Set() }
    this.receiver = registration
    return async () => {
      if (this.receiver === registration) this.receiver = undefined
      await Promise.allSettled([...registration.pending])
    }
  }

  /**
   * Subscribe a task to a source instance. Multiple sources can feed one task and one source can feed multiple tasks.
   * @param source - Source whose output is ready for delivery, rather than an intermediate observation value.
   * @param taskId - Task identity interpreted by the registered task service.
   * @returns Connection owned by the composing plugin; dispose it before releasing the task service.
   * @throws SourceError with SOURCE_TASK_RECEIVER_UNAVAILABLE if no task service is installed. Later receiver
   * removal rejects output through the source's aggregate failure; an existing connection never silently rebinds.
   */
  connect(source: AutomationSource<AutomationCandidate>, taskId: AutomationTaskId): SourceConnection {
    const registration = this.receiver
    if (registration === undefined) {
      throw new SourceError('Mount an automation-task receiver before connecting a source.', 'SOURCE_TASK_RECEIVER_UNAVAILABLE')
    }
    return source.subscribe((candidate) => {
      if (this.receiver !== registration) {
        return Promise.reject(new SourceError('The connected task service has been unloaded. Recreate the source connection.',
          'SOURCE_TASK_RECEIVER_UNAVAILABLE'))
      }
      const work = Promise.resolve().then(() => registration.receiver.deliver(taskId, candidate))
      registration.pending.add(work)
      void work.then(() => registration.pending.delete(work), () => registration.pending.delete(work))
      return work
    })
  }
}

export default AutomationTaskRouter

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Connections from typed source instances to the installed automation-task service. */
    automationTasks: AutomationTaskRouter
  }
}

export type * from './types.ts'
export type { AutomationSource } from './source.ts'
export { SourceError } from './error.ts'
