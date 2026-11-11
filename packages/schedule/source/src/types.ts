/** Typed source subscriptions and automation-task delivery values. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity interpreted by the registered automation-task service. */
export type AutomationTaskId = Branded<'AutomationTaskId'>

/**
 * A receiver owns its state and resolves only after accepting the value.
 * @param value - Typed output from the subscribed source instance.
 * @returns Resolves after acceptance; rejection reports a failure without implying rollback.
 */
export type SourceReceiver<T> = (value: T) => Promise<void>

/** One subscription, independent of every other subscriber to the same source. */
export interface SourceConnection {
  /**
   * Stop accepting values immediately and await already accepted calls. Repeated calls await the same work.
   * A receiver must not await disposal of its own connection from inside an accepted call.
   */
  dispose(): Promise<void>
}

/** Content produced by a source for delivery to an automation task. */
export interface AutomationCandidate {
  /** Additional input accompanying the task's stored instruction. */
  readonly text: string
}

/** Task delivery is acknowledged by persistence, not by model completion. */
export interface AutomationTaskReceiver {
  /**
   * Deliver additional input to an active task, preserving its scheduled occurrence.
   * @param taskId - Stored task identity.
   * @param candidate - Source-produced input.
   * @returns Resolves after durable inbox acknowledgement and the task's delivery record commit.
   * @throws If the task is missing, inactive, busy, or delivery fails. A failure may follow partial persistence;
   * callers must not retry automatically.
   */
  deliver(taskId: AutomationTaskId, candidate: AutomationCandidate): Promise<void>
}

/** Handling-relevant failures from source subscriptions and task routing. */
export type SourceErrorCode =
  | 'SOURCE_CLOSED'
  | 'SOURCE_DELIVERY_FAILED'
  | 'SOURCE_TASK_RECEIVER_UNAVAILABLE'
  | 'SOURCE_TASK_RECEIVER_DUPLICATE'
  | 'SOURCE_TASK_UNAVAILABLE'
  | 'SOURCE_TASK_BUSY'
  | 'SOURCE_TASK_INACTIVE'
