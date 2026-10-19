/** Require a live-session checkpoint before the recorded minimal-profile model requests. */
export const name = 'minimal-checkpoint-observer'
export const inject = ['llm', 'sessions', 'sessionPersistence']

/**
 * Observe checkpoints without flushing or altering the recorded model transcript.
 * @param ctx - Plugin context owning the checkpoint and model listeners.
 */
export function apply(ctx) {
  const checkpointed = new WeakSet()
  ctx.on('session/flush', session => { checkpointed.add(session) })
  ctx.on('llm/stream', async function* (options, next) {
    const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
    if (session !== undefined) {
      if (!checkpointed.has(session)) throw new Error('sdk-minimal dispatched without a session checkpoint')
      const handle = await ctx.sessionPersistence.open(session.id, 'read')
      try {
        const { events } = await handle.read()
        if (events.length === 0) throw new Error('sdk-minimal dispatched before its history was persisted')
      } finally {
        await handle.close()
      }
    }
    yield* next()
  })
}
