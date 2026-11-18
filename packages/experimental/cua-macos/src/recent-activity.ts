/** macOS activity notices join logged tool context without changing program return values or inspect behavior. */
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CuaBackend } from '@deepseek-ai/dsh-cua'
import { NativeError } from '@deepseek-ai/dsh-cua/native-client'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Advisory activity reported after an authorized macOS Computer Use operation. */
    'cua-activity': { kind: 'cua-activity'; form: 'notice'; summary: string }
  }
}

const Activity = z.object({
  lookbackMs: z.number().int().min(1).max(2 ** 31 - 1),
  externalInputMonitoring: z.enum(['listening', 'unavailable', 'secure-input']),
  events: z.array(z.object({
    source: z.enum(['agent', 'external-input']),
    windowId: z.string().min(1).nullable(),
    ageMs: z.number().int().nonnegative(),
    operation: z.string().min(1),
  }).strict()).max(2),
}).strict()

/**
 * Defer a native activity update until the enclosing tool result is logged.
 * @param request - Authorized operation and its application handle.
 * @param value - Native JSON before shared observation or image decoding.
 * @param execution - Native or nested execution that owns the deferred context.
 * @returns Unchanged operation data without the private recentActivity field.
 */
export const handleActivityResult: NonNullable<CuaBackend['handleNativeResult']> = (request, value, execution) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.recentActivity === undefined) return value
  const activity = Activity.safeParse(value.recentActivity)
  if (!activity.success || !('appHandle' in request.params)) {
    throw new NativeError('NATIVE_PROTOCOL', 'Native activity metadata is invalid or has no application target')
  }
  execution.deferContext(createUserMessage({
    source: { kind: 'cua-activity', form: 'notice', summary: 'Computer use activity update' },
    content: [{
      type: 'text',
      text: `Recent activity (advisory only): ${JSON.stringify({ appHandle: request.params.appHandle, ...activity.data })}`,
    }],
  }))
  const { recentActivity: _activity, ...result } = value
  return result
}
