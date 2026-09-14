/**
 * Whole-client tier entry (deep import only:
 * `@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts`). Kept out of
 * the package root so slot-tier specs do not load the assembly machinery.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly
 */
export { ClientRoster } from './roster.ts'
export type { AssemblyPlan, ClientPluginModule, ClientRosterRow } from './roster.ts'
export { TestClient } from './test-client.ts'
export type { TestClientOptions } from './test-client.ts'
export { remoteDefaultResponses } from './remote-default-responses.ts'
export { bundleRoster, webApp } from './bundle-roster.ts'
export { createClientTest } from './vitest.ts'
export type { ClientTestFixtures } from './vitest.ts'
