/**
 * Browser half: `ctx.resources` (protocol-registered providers, pinning, live
 * sources) and the `useResource` global standard hook.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RootStandardSourceContribution } from '@deepseek-ai/dsh-client-ui-slots'
import { ResourceRegistry } from './resources.ts'

export type {
  ResourceOpenContext,
  ResourceProtocol,
  ResourceProvider,
  Resources,
  ResourceSnapshot,
  ResourceStatus,
  UseResource,
} from './contract.ts'
export type { ResourceProtocolMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Required browser services. */
export const inject = ['slots']

/**
 * Client plugin body: provide `ctx.resources` and contribute the `resource`
 * root keyed hook that reaches every slot component as `useResource`.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Built at apply's top level, never inside an effect: other plugins call
  // `register()` from their own apply, and it adds an effect to this fiber.
  const resources = new ResourceRegistry(ctx)
  const disposeService = ctx.reflect.provide('resources', resources)
  // Registered first, so it tears down last: the face outlives every provider
  // that registered into it.
  ctx.effect(() => () => { void disposeService() }, 'client-resources: service face')
  ctx.slots.provideRoot({
    keyedHooks: { resource: address => resources.source(address) },
  } satisfies RootStandardSourceContribution)
}
