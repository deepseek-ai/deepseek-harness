/** Window-specific input notices for an already scheduled model step. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CuaBackend, CuaWindowRead } from '@deepseek-ai/dsh-cua'
import { NativeError } from '@deepseek-ai/dsh-cua/native-client'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Activity detected since the Agent last observed a window. */
    'cua-activity': { kind: 'cua-activity'; form: 'notice'; summary: string }
  }
}

interface Watches {
  client: CuaWindowRead['client']
  access: CuaWindowRead['access']
  apps: Map<CuaWindowRead['appHandle'], Map<string, string>>
}

const Rows = z.array(z.object({
  windowId: z.string().regex(/^[1-9][0-9]{0,9}$/),
  source: z.enum(['agent', 'external-input']),
  ageSeconds: z.number().int().nonnegative(),
}).strict())

/**
 * Collect recent input on a naturally scheduled model step during the observing turn.
 * @param ctx - macOS provider owning the listeners.
 * @returns Callback for successful window reads on an authorized connection.
 */
export function watchWindowActivity(ctx: Context): NonNullable<CuaBackend['windowRead']> {
  const watches = new WeakMap<CuaWindowRead['agent']['session'], Watches>()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const watch = watches.get(session)
    watches.delete(session)
    if (watch && !watch.client.disposed) {
      void watch.client.requestCleanup('clearWindowActivity', {}).catch((error: unknown) => {
        ctx.logger.warn('Could not clear window activity at turn end: %s', error)
      })
    }
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    const watch = watches.get(agent.session)
    if (decision.kind === 'reject' || !watch || watch.client.disposed) return decision
    const lines: string[] = []
    for (const [handle, windows] of watch.apps) {
      const observations = Object.fromEntries(windows)
      try {
        const result = await watch.access.readCached(watch.client, handle, signal, authorized =>
          watch.client.request('takeWindowActivity', { appHandle: handle, observations }, authorized))
        const rows = Rows.parse(result)
        if (rows.some(row => !windows.has(row.windowId))) throw new NativeError('NATIVE_PROTOCOL', 'Unrequested window activity')
        for (const { windowId, ageSeconds, source } of rows) {
          const actor = source === 'agent' ? 'another agent' : 'a user or an automated program'
          const elapsed = ageSeconds === 0 ? 'less than a second' : `${ageSeconds} ${ageSeconds === 1 ? 'second' : 'seconds'}`
          lines.push(`Activity from ${actor} was last detected on window ${windowId}, ${elapsed} ago.`)
        }
      } catch (error) {
        if (signal.aborted) return decision
        ctx.logger.warn('Could not check recent window activity: %s', error)
      }
    }
    if (!lines.length || signal.aborted || watches.get(agent.session) !== watch) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: 'cua-activity', form: 'notice', summary: 'Computer use activity update' },
      content: [{ type: 'text', text: ['<system-reminder>', ...lines, 'Your actions may have been influenced.', '</system-reminder>'].join('\n') }],
    })] }
  }, { prepend: true })

  return ({ agent, client, access, appHandle, windowId }) => {
    let watch = watches.get(agent.session)
    if (!watch || watch.client !== client) {
      watch = { client, access, apps: new Map() }
      watches.set(agent.session, watch)
    }
    return (reply) => {
      const receipt = z.object({ activityObservedAt: z.string().regex(/^[0-9]{1,20}$/) }).safeParse(reply)
      if (!receipt.success) return
      const windows = watch.apps.get(appHandle)
      const since = receipt.data.activityObservedAt
      if (windows) {
        const previous = windows.get(windowId)
        if (!previous || BigInt(since) > BigInt(previous)) windows.set(windowId, since)
      } else watch.apps.set(appHandle, new Map([[windowId, since]]))
    }
  }
}
