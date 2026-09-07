import type { Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/**
 * Create a mutable in-memory Inbox stub for tests that exercise only the public
 * queue operations. Durable events, projection validation, and live Inbox
 * notifications require a real Agent created by the AgentLoop test harness.
 * @returns an Inbox backed by two process-local arrays.
 */
export function createInboxStub(): Inbox {
  const pending: Record<InboxTarget, UserMessage[]> = {
    'next-turn': [],
    'next-step': [],
  }

  const locate = (messageId: MessageId): { target: InboxTarget; index: number } | undefined => {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = pending[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  return {
    get nextTurn() { return pending['next-turn'] },
    get nextStep() { return pending['next-step'] },
    clear() {
      pending['next-step'].splice(0)
      pending['next-turn'].splice(0)
    },
    append(target, message) {
      pending[target].push(message)
    },
    prepend(target, message) {
      pending[target].unshift(message)
    },
    replace(messageId, message) {
      const location = locate(messageId)
      if (location === undefined) return false
      pending[location.target].splice(location.index, 1, message)
      return true
    },
    remove(messageId) {
      const location = locate(messageId)
      if (location === undefined) return false
      pending[location.target].splice(location.index, 1)
      return true
    },
    splice(target, start, deleteCount, inserted) {
      return pending[target].splice(start, deleteCount, ...inserted)
    },
  }
}

/**
 * Create an unsupported Inbox placeholder for Agent stubs whose tests do not exercise Inbox behavior.
 * @returns an Inbox whose pending lists are empty and whose mutation methods throw.
 */
export function unsupportedInbox(): Inbox {
  const rejectMutation = (): never => {
    throw new Error('this test Agent does not support Inbox mutations')
  }
  return {
    nextTurn: [],
    nextStep: [],
    clear: rejectMutation,
    append: rejectMutation,
    prepend: rejectMutation,
    replace: rejectMutation,
    remove: rejectMutation,
    splice: rejectMutation,
  }
}
