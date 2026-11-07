/** macOS system-pointer options and session approval for physical hover. */
import type { Context } from '@deepseek-ai/cordis'
import { CuaSessionPermissions, type CuaBackend } from '@deepseek-ai/dsh-cua'
import { NativeError } from '@deepseek-ai/dsh-cua/native-client'
import { MouseMoveTargets, Request } from '@deepseek-ai/dsh-cua/protocol'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { z } from 'zod'
import { mouseControlPrompt } from './mouse-control-locales.ts'

const pointerOptions = { useSystemPointer: z.boolean().optional().describe('Request use of the system pointer. The Host checks permission before dispatch.') }
const mouseMove = z.strictObject({ method: z.literal('mouseMove'), params: z.union(MouseMoveTargets.map(target => target.extend(pointerOptions))) })

/** macOS advertises and validates its additional option for element and coordinate moves. */
export const MacRequest = z.discriminatedUnion('method', Request.options.map(op => op.shape.method.value === 'mouseMove' ? mouseMove : op))

/**
 * Select the native route on the provider's parsed request, before coordinates are rechecked and dispatched.
 * @param ctx Provider context owning this set of Session decisions.
 * @param requireApproval Whether physical moves need the user's approval.
 * @returns Preparation for mouseMove with an optional user interaction.
 */
export function mouseMovePreparation(ctx: Context, requireApproval: boolean): NonNullable<CuaBackend['prepareMouseMove']> {
  const permissions = new CuaSessionPermissions(ctx)
  const permission = 'system-pointer'
  return (agent, params) => {
    if (params.useSystemPointer !== true) {
      params.useSystemPointer = params.useSystemPointer === false ? false : permissions.allowed(agent, permission)
      return undefined
    }
    if (agent.session.header.origin === 'subagent') {
      throw new NativeError('MOUSE_CONTROL_UNAVAILABLE', "Delegated tasks cannot move the user's pointer. Use AX hover, click, or performAction. If the task requires a physical hover, report that step in your final result for the main task.")
    }
    if (!requireApproval) return undefined
    params.useSystemPointer = false
    return async (signal) => {
      try {
        if (!await permissions.request(agent, permission, mouseControlPrompt, signal)) {
          throw new NativeError('MOUSE_CONTROL_DENIED', 'The user declined system-pointer movement for this session. No input was sent. Use pointer-free actions.')
        }
      } catch (error) {
        if (error instanceof UserQuestionError) {
          if (error.code === 'APPROVAL_PENDING') throw new NativeError('MOUSE_CONTROL_PENDING', error.message, { cause: error })
          if (error.code === 'NO_PROVIDER') throw new NativeError('MOUSE_APPROVAL_UNAVAILABLE', error.message, { cause: error })
          if (error.code === 'ASK_CANCELLED') throw new NativeError('MOUSE_APPROVAL_CANCELLED', 'The mouse control request was dismissed. Continue without mouse control unless the user asks to reconsider', { cause: error })
        }
        throw error
      }
      params.useSystemPointer = true
    }
  }
}
