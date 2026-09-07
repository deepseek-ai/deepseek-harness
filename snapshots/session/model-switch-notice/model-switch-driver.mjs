/** Test-only driver that selects another model after the first step's tool call. */

import { installModelSelection } from '@deepseek-ai/dsh-agent'

const SELECTED = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const selections = new WeakMap()

export const name = 'model-switch-driver'
export const inject = ['agents']

/**
 * Install the real selection helper and change its input after `todo_write`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - composition context.
 */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const selection = { current: undefined, assembled: undefined }
    selections.set(agent.session, selection)
    installModelSelection(agent.ctx, selection)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'todo/write') return
    const selection = selections.get(session)
    if (selection === undefined) throw new Error('model-switch driver requires an installed selection')
    selection.current = SELECTED
  })
  // Headless also fixes the original selection. These root waterfalls make the
  // driver authoritative; ending after step two avoids a reverse notice.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (context.agent === undefined) return assembled
    const selected = selections.get(context.agent.session)?.assembled
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })
  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    const selected = selections.get(agent.session)?.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return { ...withoutInheritedEffort, ...selected }
  })
}
