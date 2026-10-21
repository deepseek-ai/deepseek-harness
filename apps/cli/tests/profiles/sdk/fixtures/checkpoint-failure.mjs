/** Reject durable checkpoints without changing background JSONL writes. */
export const name = 'sdk-checkpoint-failure'
export const inject = ['sessionPersistence']

/**
 * Install a storage-failure signal at the public session flush event.
 * @param ctx - Plugin context owning the flush listener.
 */
export function apply(ctx) {
  ctx.on('session/flush', () => {
    throw new Error('sdk checkpoint persistence unavailable')
  })
}
