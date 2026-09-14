/** Lazy namespace access for native Remote mocks; production Remote declarations stay unchanged. */
import type { MaybeMockedDeep } from '@vitest/spy'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Native mocks for every generated Remote namespace, or an unrestricted local proxy without generated types.
 * @template Api - generated namespace map available in the caller's TypeScript program.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- An unbuilt namespace map has neither method names nor signatures.
export type MockedRemote<Api = TypertRemoteNamespaceMap> = keyof Api extends never ? any : MaybeMockedDeep<Api>

/**
 * Cache accessed namespaces and expose the current native mock for each method.
 * @param method - selects a stable endpoint mock for its configured invocation mode.
 * @returns enumerable accessed namespaces and methods; symbols and thenable probes remain inert.
 */
export function createRemoteProxy(method: (endpoint: string) => unknown): Record<string, object> {
  return new Proxy(Object.create(null) as Record<string, object>, {
    get(namespaces, namespace) {
      if (typeof namespace !== 'string' || namespace === 'then') return undefined
      return namespaces[namespace] ??= new Proxy(Object.create(null) as Record<string, unknown>, {
        get(methods, name) {
          if (typeof name !== 'string' || name === 'then') return undefined
          return methods[name] = method(`${namespace}/${name}`)
        },
      })
    },
  })
}
