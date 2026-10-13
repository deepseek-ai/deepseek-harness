import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
/** Change the file policy from outside the active PTC call while a nested tool awaits cancellation. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

export const name = 'ptc-mode-change'
export const inject = ['tools', 'sandboxPolicy']

export function apply(ctx: Context): void {
  const requested = Promise.withResolvers<Session | undefined>()
  // This continuation belongs to the test driver, outside any program's execution context.
  const changed = requested.promise.then(async (session) => {
    if (session !== undefined) setSandboxMode(session, 'read-only')
  })
  void changed.catch((error: unknown) => { ctx.logger.error(error) })
  ctx.effect(() => async () => { requested.resolve(undefined); await changed }, 'snapshot policy change')
  ctx.tools.register(defineTool({
    name: 'wait_for_mode_change',
    description: 'Wait while the test driver changes the Session file policy.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (_args, exec) => {
      if (exec.agent === undefined) throw new Error('mode-change fixture requires an Agent')
      requested.resolve(exec.agent.session)
      return new Promise<string>((resolve) => {
        if (exec.signal.aborted) resolve('canceled')
        else exec.signal.addEventListener('abort', () => { resolve('canceled') }, { once: true })
      })
    },
  }))
}
