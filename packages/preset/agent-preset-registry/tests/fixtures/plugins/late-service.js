// Publishes into the ROOT realm only after its plugin body returned, escaping
// the one-shot mount audit. Exercises the package invariant.
export const name = 'late-service'
export function apply(ctx, config) {
  globalThis.__PUBLISH_LATE__ = () => ctx.effect(() => ctx.reflect.provide(config.service, { label: 'late' }))
}
