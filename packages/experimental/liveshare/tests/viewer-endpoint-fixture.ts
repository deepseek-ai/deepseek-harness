/**
 * Host endpoint definitions and Loader entry names for cases that exercise the viewer declaration surface.
 *
 * A declaration is accepted only for a live Host endpoint owned by the declaring plugin's package, so a case
 * needs both: generated invocations for that package, and the entry name the Loader installs on the
 * declaring fiber before the plugin body runs. The Loader owns that field; these helpers install the same
 * values a real Loader composition would, without booting a config tree.
 */
import type { Context, Fiber, Inject } from '@deepseek-ai/cordis'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { z } from 'zod'

/**
 * One generated Host contribution whose invocations are the endpoints `packageName` owns.
 * @param packageName - Package that compiled the endpoints.
 * @param endpoints - Endpoint names, each `<namespace>/<method>`.
 * @returns Contribution holding one direct invocation per endpoint, with the generated `<package>#<endpoint>` id.
 */
export function endpointContribution(packageName: string, endpoints: readonly string[]): TypertContribution {
  return {
    package: packageName,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: endpoints.map((endpoint) => {
      const separator = endpoint.indexOf('/')
      if (separator <= 0) throw new Error(`endpoint ${JSON.stringify(endpoint)} is not a <namespace>/<method> name`)
      const namespace = endpoint.slice(0, separator)
      const method = endpoint.slice(separator + 1)
      return {
        id: `${packageName}#${endpoint}`,
        service: namespace,
        namespace,
        method,
        invocation: { kind: 'direct' as const },
        parameters: [],
        result: { mode: 'strict' as const, typeSymbol: `${packageName}#Result`, create: () => z.string() },
      }
    }),
  }
}

/**
 * Mount `apply` as a plugin whose fiber carries `packageName` as its Loader entry name.
 *
 * The Loader assigns `fiber.entry` from its own `internal/plugin` observer, which runs before Cordis defers
 * the plugin body to a microtask, and every plugin the body mounts inherits the same entry. This replicates
 * both passes: the field is installed on the plugin's fiber and on each plugin it mounts in turn.
 * @param host - Context to mount under.
 * @param name - Plugin runtime name, as the declaring plugin would have in its composition.
 * @param packageName - Loader entry module name, which the surface compares against the endpoint's owner.
 * @param apply - The plugin body.
 * @param inject - Services the plugin waits for, as its composition would declare them.
 * @returns The mounted fiber, settling once the body has run.
 */
export function mountDeclaringPlugin(
  host: Context,
  name: string,
  packageName: string,
  apply: (ctx: Context) => void,
  inject?: Inject,
): Fiber & PromiseLike<Fiber> {
  const entry = { options: { id: name, name: packageName } }
  const declaring = new Set<Fiber>()
  host.on('internal/plugin', (fiber) => {
    const root = fiber.runtime?.name === name
    // A plugin's own nested mounts inherit its entry, so the entry follows the fiber tree, not the name.
    if (!root && !declaring.has(fiber.parent.fiber)) return
    declaring.add(fiber)
    Object.defineProperty(fiber, 'entry', { value: entry, configurable: true })
  })
  return host.plugin(inject === undefined ? { name, apply } : { name, apply, inject })
}
