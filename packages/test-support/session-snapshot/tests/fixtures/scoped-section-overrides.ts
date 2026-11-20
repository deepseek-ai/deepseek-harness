/** Scoped section overrides and retirement through real plugin lifetimes. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'scoped-section-overrides'
export const inject = ['systemPrompt']

/**
 * Reveal the inherited section after unloading its override, then retire the source.
 * @param ctx - scenario plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  const sectionName = 'snapshot:shared'
  const parent = ctx.plugin(Object.assign((inner: Context) => {
    inner.systemPrompt.section({
      name: sectionName, order: 400, text: 'Parent instructions: read task.txt.',
      replacement: 'The parent instructions apply again.', retirement: 'The parent instructions no longer apply.',
    })
  }, { inject: ['systemPrompt'] }))
  await parent
  let child: ReturnType<Context['plugin']> | undefined
  let reads = 0
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError || exec.name !== 'read') return downstream
    assert(exec.agent, 'section override fixture requires an Agent')
    reads++
    if (reads === 1) {
      child = exec.agent.ctx.plugin(Object.assign((inner: Context) => {
        inner.systemPrompt.section({
          name: sectionName, order: 400, text: 'Child instructions: read task.txt again.',
          replacement: 'The child instructions now apply.', retirement: 'The child instructions no longer apply.',
        })
      }, { inject: ['systemPrompt'] }))
      await child
    } else if (reads === 2) {
      assert(child)
      await child.dispose()
    } else {
      await parent.dispose()
    }
    return downstream
  })
  const expected = [
    { state: 'active', text: 'Parent instructions: read task.txt.' },
    { state: 'active', text: 'Child instructions: read task.txt again.' },
    { state: 'active', text: 'Parent instructions: read task.txt.' },
    { state: 'retired', text: 'The parent instructions no longer apply.' },
  ]
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    requests++
    const records = options.messages.flatMap(message => message.role === 'system'
      ? (message.source.sections ?? []).filter(section => section.name === sectionName).map((section) => {
        const index = section.state === 'retired' ? section.noticeIndex?.[0] : section.contentIndex
        assert(index !== undefined)
        const block = message.content[index]
        assert(block?.type === 'text')
        return { state: section.state, text: block.text }
      })
      : [])
    assert.deepEqual(records, expected.slice(0, requests), 'request retains each committed override and retires only after the entire chain is gone')
    return next()
  })
}
