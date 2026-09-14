/**
 * `remote.<ns>` services for the whole-client tier, without the generated
 * Remote clients. Cordis resolves `ctx.remote.<ns>` to whichever service is
 * registered under `remote.<ns>` (vendor cordis `utils.ts`, traceable get), so
 * the carrier provides one Proxy per namespace: `remote.<ns>.<method>(...args)`
 * calls the endpoint `<ns>/<method>` over the roster's own Connection with the
 * positional `args`, as a stream when the mock registered a stream script for
 * it and as a unary call otherwise. A unary answer is returned unchanged and a
 * unary rejection is folded the way the generated client folds a carrier
 * throw (`gateway/internal`, or `gateway/cancelled` once the caller's signal
 * aborted), so product code that never awaits a rejection sees none; stream
 * items and failures pass through as the stream yields them.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/remote-proxies
 */
import type { Context } from '@deepseek-ai/cordis'
import { cancelledFailure, carrierFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import type { ClientPluginModule } from './roster.ts'

/** The assembly row the proxies stand in for; its generated clients exist only in built `lib/`. */
export const REMOTES_PACKAGE = '@deepseek-ai/dsh-api-remotes'

const PREFIX = 'remote.'

/**
 * Namespaces to provide: every `remote.<ns>` a roster module injects, plus the
 * namespace of every endpoint the mock has a rule for.
 * @param modules - loaded roster modules.
 * @param mock - the spec's mock.
 * @returns sorted namespace names.
 */
export function remoteNamespacesOf(modules: Iterable<ClientPluginModule>, mock: RemoteMock): readonly string[] {
  const names = new Set<string>()
  for (const module of modules) {
    for (const service of injectNames(module.inject)) if (service.startsWith(PREFIX)) names.add(service.slice(PREFIX.length))
  }
  for (const endpoint of mock.endpoints()) {
    const slash = endpoint.indexOf('/')
    if (slash > 0 && !endpoint.startsWith('$')) names.add(endpoint.slice(0, slash))
  }
  return [...names].sort()
}

function injectNames(inject: ClientPluginModule['inject']): readonly string[] {
  if (inject === undefined) return []
  if (Array.isArray(inject)) return inject as readonly string[]
  return Object.keys(inject)
}

/**
 * Plugin providing the namespace proxies; `TestClient.start` mounts it before the Loader rows.
 * @param namespaces - namespaces to provide.
 * @param mock - the spec's mock, asked for each endpoint's mode.
 * @returns the plugin.
 */
export function remoteProxiesPlugin(namespaces: readonly string[], mock: RemoteMock): ClientPluginModule {
  return {
    inject: ['connection'],
    apply(ctx: Context) {
      const connection = ctx.get('connection') as ConnectionHandle
      for (const namespace of namespaces) ctx.provide(`${PREFIX}${namespace}`, namespaceProxy(namespace, connection, mock))
    },
  }
}

function namespaceProxy(namespace: string, connection: ConnectionHandle, mock: RemoteMock): object {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (_target, property) => {
      // No `then`: awaiting the namespace object itself must not call a method.
      if (typeof property !== 'string' || property === 'then') return undefined
      return (...values: readonly unknown[]): unknown => {
        const endpoint = `${namespace}/${property}`
        const args = [...values]
        const signal = args.at(-1) instanceof AbortSignal ? (args.pop() as AbortSignal) : undefined
        if (mock.modeOf(endpoint) === 'stream') {
          const open = connection.rpc.open
          /* v8 ignore next -- the mock transport always supplies openStream, so the Connection carrier exposes open. */
          if (open === undefined) throw new Error(`client-test-runtime: ${endpoint} is a stream but the carrier has no in-process opener`)
          return open('/api', endpoint, { args }, signal ?? new AbortController().signal)
        }
        return connection.rpc.call('/api', endpoint, { args }, signal).catch((error: unknown) =>
          (signal?.aborted === true ? cancelledFailure(endpoint, error) : carrierFailure(endpoint, error)))
      }
    },
  })
}
