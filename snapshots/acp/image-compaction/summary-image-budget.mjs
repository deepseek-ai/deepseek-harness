/** Authored summary-route rejection for the image-compaction snapshot. */
export const name = 'summary-image-budget'
export const inject = ['llm']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-local context.
 */
export function apply(ctx) {
  let failed = false
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== 'compaction' || failed) {
      yield* next()
      return
    }
    failed = true
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: {
        code: 'IMAGE_OFFLOAD_REQUIRED', message: 'authored summary image budget failure', offloadImages: 1,
      } },
    }
  })
}
