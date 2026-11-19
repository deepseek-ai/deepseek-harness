/** Persona sections share ordinary registration precedence and plugin disposal. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import * as Persona from '@deepseek-ai/dsh-persona'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'persona-section-overrides'
export const inject = ['systemPrompt']

/**
 * Stack complete and ordinary personas in one scope, then restore deployment defaults.
 * @param ctx - scenario plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  const parent = ctx.plugin(Persona, {
    prefix: 'Persona instructions: read task.txt.', suffix: 'Persona suffix.',
  })
  await parent
  let child: ReturnType<Context['plugin']> | undefined
  let reads = 0
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError || exec.name !== 'read') return downstream
    reads++
    if (reads === 1) {
      child = ctx.plugin(Persona, {
        prefix: 'Complete persona instructions: read task.txt again.',
        suffix: 'Hidden complete persona suffix.', complete: true,
      })
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
    ['Persona instructions: read task.txt.', 'Persona suffix.'],
    ['Complete persona instructions: read task.txt again.'],
    ['Persona instructions: read task.txt.', 'Persona suffix.'],
    ['Deployment instructions: read task.txt.', 'Deployment suffix.'],
  ]
  const personaNames = new Set([Persona.PERSONA_PREFIX_SECTION, Persona.PERSONA_SUFFIX_SECTION])
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    requests++
    const systems = options.messages.filter(message => message.role === 'system')
    assert.equal(systems.length, requests)
    const current = systems.at(-1)
    assert(current)
    const sections = current.source.sections ?? []
    const persona = sections.filter(section => personaNames.has(section.name))
    assert(persona.every(section => section.state === 'active'), 'remaining registrations prevent persona retirement')
    const text = persona.map((section) => {
      assert(section.contentIndex !== undefined)
      const block = current.content[section.contentIndex]
      assert(block?.type === 'text')
      return block.text
    })
    assert.deepEqual(text, expected[requests - 1])
    assert.equal(current.source.complete === true, requests === 2)
    if (requests === 2) assert.deepEqual(sections.map(section => section.name), [Persona.PERSONA_PREFIX_SECTION])
    return next()
  })
}
