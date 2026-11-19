/** Assert repeat reminders in the actual requests after real PTC program execution. */
import assert from 'node:assert/strict'

export const name = 'repeat-request-fixture'
export const inject = ['llm']

/**
 * Check every request against the configured model-direct repeat thresholds.
 * @param {import('@deepseek-ai/cordis').Context} ctx - isolated snapshot Host.
 */
export function apply(ctx) {
  const expected = [[], [], [], ['run_code × 3'], ['run_code × 3'], ['run_code × 3', 'run_code × 5']]
  let requests = 0
  ctx.on('llm/stream', (options, next) => {
    const summaries = options.messages
      .filter(message => message.role === 'user' && message.source?.kind === 'repeat-tool-reminder')
      .map(message => message.source.summary)
    assert.deepEqual(summaries, expected[requests], 'Only model-direct run_code calls produce reminders')
    const results = options.messages.filter(message => message.role === 'tool')
    assert.equal(results.length, requests, 'Each program result reaches the next model request')
    assert.ok(results.every(result => !result.isError), 'Every repeated program completes successfully')
    requests += 1
    return next()
  })
}
