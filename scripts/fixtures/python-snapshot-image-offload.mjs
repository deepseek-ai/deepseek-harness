/** One admitted image and one authored failure for the Python SDK event snapshot. */

/** Cordis fixture identity. */
export const name = 'python-snapshot-image-offload'

/** Admission and request hooks supplied by the shipped SDK profile. */
export const inject = ['attachments', 'agents', 'llm']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-local host context.
 * @param {{ parentSessionId: string }} config - The one session receiving the authored failure.
 */
export function apply(ctx, config) {
  let injected = false
  let failed = false
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (agent.id !== config.parentSessionId || injected || decision.kind === 'reject') return decision
    const content = await ctx.attachments.admitPromptContent([{
      type: 'image',
      mediaType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    }])
    injected = true
    return {
      ...decision,
      messages: [...decision.messages, { id: 'python-snapshot-image', role: 'user', content, source: { kind: name } }],
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.sessionId !== config.parentSessionId || options.purpose !== undefined || failed) {
      yield* next()
      return
    }
    failed = true
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: {
        code: 'IMAGE_OFFLOAD_REQUIRED', message: 'authored image budget failure', offloadImages: 1,
      } },
    }
  })
}
