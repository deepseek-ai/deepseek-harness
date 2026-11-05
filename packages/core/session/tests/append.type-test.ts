/** Compile-time checks for single and multiple event admission. */
import { expectTypeOf } from 'vitest'
import type { Session, SessionEvent, SessionEventInput } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Check result cardinality and event-specific payload and surface requirements.
 * @param session - target Session; this function is typechecked without execution.
 * @param message - user input with durable identity.
 */
export function checkAppendTypes(session: Session, message: UserMessage): void {
  expectTypeOf(session.append('turn/start', { turn: 1 })).toEqualTypeOf<SessionEvent<'turn/start'>>()
  const inputs: readonly SessionEventInput[] = [
    ['turn/start', { turn: 1 }],
    ['user/message', message, { surfaceOp: 'append' }],
  ]
  expectTypeOf(session.append(inputs)).toEqualTypeOf<readonly SessionEvent[]>()
  // @ts-expect-error -- message-producing members require a surface operation.
  session.append([['user/message', message]])
  // @ts-expect-error -- log-only members cannot carry a surface operation.
  session.append([['turn/start', { turn: 1 }, { surfaceOp: 'append' }]])
  // @ts-expect-error -- each payload must match its event type.
  session.append([['turn/start', message]])
}
