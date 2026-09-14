/** Test-scoped Remote mock and lazy client boot, owned by native Vitest fixtures. */
import { test, type TestAPI } from 'vitest'
import { RemoteMock, type MockedRemote } from '@deepseek-ai/dsh-remote-mock'
import type { AssemblyPlan } from './roster.ts'
import { remoteDefaultResponses } from './remote-default-responses.ts'
import { TestClient, type TestClientOptions } from './test-client.ts'

/** Per-test controls; configure the mock before awaiting `start()`. */
export interface ClientTestFixtures {
  /** Fresh mock with the assembly's default responses already loaded. */
  mock: RemoteMock
  /** Namespace proxy backed by the same native mocks used by the Connection carrier. */
  remote: MockedRemote
  /** Await the one client owned by this test; rejects after the fixture closes. */
  start: () => Promise<TestClient>
}

/**
 * Extend Vitest with a fresh mock and a lazy, automatically disposed client. Repeated `start()` calls share one
 * promise. Await it to observe startup failures; cleanup waits for startup but does not rethrow its rejection.
 * Missing mock responses still fail teardown even when no client was started. Page globals remain environment-owned.
 * @param plan - roster and replacement modules, shared as configuration rather than as a running client.
 * @param options - mount and readiness settings passed to `TestClient.start`.
 * @returns Vitest's test function with test-scoped `mock` and `start` fixtures.
 */
export function createClientTest(plan: AssemblyPlan, options: TestClientOptions = {}): TestAPI<ClientTestFixtures> {
  return test.extend<ClientTestFixtures>({
    remote: async ({ mock }, use) => {
      await use(mock.remote)
    },
    mock: async ({}, use) => {
      const mock = RemoteMock.create().load(remoteDefaultResponses)
      try {
        await use(mock)
      } finally {
        mock.assertNoUnmatched()
      }
    },
    start: async ({ mock }, use) => {
      let pending: Promise<TestClient> | undefined
      let closed = false
      const start = (): Promise<TestClient> => {
        if (closed) return Promise.reject(new Error('client-test-runtime: start() called after its test fixture closed'))
        if (pending === undefined) {
          pending = TestClient.start(plan, mock, options)
          // Startup belongs to the caller; keep a rejection handler attached until teardown can await it.
          void pending.catch(() => undefined)
        }
        return pending
      }
      try {
        await use(start)
      } finally {
        closed = true
        const client = await pending?.catch(() => undefined)
        await client?.dispose()
      }
    },
  })
}
