/**
 * Test-only current system updates and request routing to a second model after tool execution. The
 * `model-switch-compaction` and `model-switch-overflow-recovery` scenarios both load it.
 */
import assert from 'node:assert/strict'

export const name = 'model-switch-compaction-driver'
export const inject = ['tools', 'systemPrompt', 'llm']

/**
 * Rebuild the latest section version when compaction follows a model switch.
 * @param {import('@deepseek-ai/cordis').Context} ctx - composition context.
 * @param {{ switchAfterCalls?: number }} [config] - completed bash calls before the switch; two when omitted.
 */
export function apply(ctx, config) {
  const switchAfterCalls = config?.switchAfterCalls ?? 2
  const sectionName = 'snapshot:model-switch-guidance'
  const sectionText = version => `Model-switch guidance version ${version}.`
  let completedCalls = 0
  let conversationRequests = 0
  ctx.systemPrompt.section({
    name: sectionName,
    order: 700,
    text: () => sectionText(completedCalls + 1),
    replacement: 'The model-switch guidance below replaces its earlier version.',
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'bash' && !result.isError) {
      completedCalls++
      if (completedCalls === switchAfterCalls) {
        if (exec.agent === undefined) throw new Error('model-switch compaction requires a calling Agent')
        exec.agent.model.select({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
      }
    }
    return result
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== 'compaction' && conversationRequests++ === 2) {
      const systems = options.messages.filter(message => message.role === 'system')
      assert.equal(systems.length, 1, 'Compaction consolidates current instructions at the system head')
      const current = systems[0]
      assert.equal(current.source.reset, true)
      const currentSection = current.source.sections.find(section => section.name === sectionName)
      assert.equal(current.content[currentSection.contentIndex].text, sectionText(completedCalls + 1))
    }
    yield* next()
  })
}
