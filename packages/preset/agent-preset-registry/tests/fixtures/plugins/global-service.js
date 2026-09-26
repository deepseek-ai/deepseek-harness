// Publishes a service with no `isolate` realm, so it lands in the ROOT realm.
export const name = 'global-service'
export function apply(ctx, config) {
  ctx.effect(() => ctx.reflect.provide(config.service, { label: config.label }))
}
