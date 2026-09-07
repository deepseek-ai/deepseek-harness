/** Exercise real feedback services before the SDK closes the recorded root turn. */
export const name = 'snapshot-feedback-producer'
export const inject = ['commands', 'messageFeedback']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Composed runtime services.
 */
export function apply(ctx) {
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent.session.header.parentSession !== undefined) return
    const messages = agent.session.deriveMessages()
    const message = messages.findLast(message => message.role === 'assistant')
    if (message === undefined) throw new Error('feedback snapshot requires an assistant message')
    const command = await ctx.commands.execute(agent, '/feedback The session needs a clearer explanation.', [], signal)
    if (command?.result.kind !== 'success') throw new Error('feedback command did not succeed')
    const target = { sessionId: agent.id, messageId: message.id }
    const created = await ctx.messageFeedback.put({ ...target, rating: 'negative', note: 'Explain the result.', ifVersion: null })
    if (!created.ok) throw new Error(created.error.code)
    const edited = await ctx.messageFeedback.put({ ...target, rating: 'positive', note: 'The explanation is clear now.', ifVersion: created.value.version })
    if (!edited.ok) throw new Error(edited.error.code)
    const deleted = await ctx.messageFeedback.delete({ ...target, ifVersion: edited.value.version })
    if (!deleted.ok) throw new Error(deleted.error.code)
    if (JSON.stringify(agent.session.deriveMessages()) !== JSON.stringify(messages)) {
      throw new Error('feedback changed model-visible messages')
    }
  })
}
