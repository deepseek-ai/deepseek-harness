/**
 * Remove the machine's proxy configuration from every Vitest process.
 *
 * A developer's Clash and a CI runner's squid both export `HTTP_PROXY` and its siblings. Now that
 * the harness honors them, an ambient value silently decides test outcomes: a request meant for a
 * local fixture server is sent to a proxy that cannot resolve the fixture's hostname, and the
 * proxy's error page is recorded as the expected output. The same value also stands in for "what
 * the user exported" in any assertion about inherited proxy names.
 *
 * Clearing here gives every suite one known starting environment, so a test that needs a proxy sets
 * exactly the names it means to exercise. Suites that spawn a real `dsh` still clear the child's
 * environment themselves — they must hold whether or not a Vitest setup ran.
 *
 * One name resists this: `NODE_USE_ENV_PROXY`. Node samples the proxy environment when the process
 * starts, so deleting the variable from a setup file cannot unbind the built-in `fetch` it already
 * configured. A shell that exports it must unset it before running the suite. The names a proxy
 * application or a corporate profile actually exports — the eight below — are fully handled, because
 * only this repository's own resolver reads them and it runs after this.
 *
 * Real-API e2e is cleared too. Before proxy support existed every request connected directly and
 * that suite passed, so a direct connection is the environment it is known to work in; leaving the
 * ambient proxy in place would newly stake it on the proxy reaching the provider.
 * @module
 */

import { globSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROXY_ENV_NAMES } from '../packages/util/http-proxy/src/policy.ts'

/** The flag a Node process reads before honoring the names above; ambient in the same way. */
const NODE_PROXY_FLAG = 'NODE_USE_ENV_PROXY'

/** This module's path as a `setupFiles` entry, so its own wiring test names it once. */
export const TEST_PROXY_SETUP_FILE = './scripts/test-proxy-environment.ts'

/**
 * Every Vitest configuration in the repository, discovered rather than listed: the web suites carry
 * no `setupFiles` today, and a hand-written list would let one of them gain a setup without gaining
 * this one. The wiring test asserts only over the configurations that declare a setup at all.
 *
 * @returns repository-relative config paths, sorted.
 */
export function vitestConfigFiles(): string[] {
  return globSync('vitest*.ts', { cwd: resolve(import.meta.dirname, '..') }).sort()
}

/**
 * Delete every proxy name from one environment.
 *
 * @param env - the environment to clear.
 * @returns the names that carried a value, in the order checked.
 */
export function clearAmbientProxyEnv(env: NodeJS.ProcessEnv): string[] {
  const cleared: string[] = []
  for (const name of [...PROXY_ENV_NAMES, NODE_PROXY_FLAG]) {
    if (env[name] === undefined) continue
    cleared.push(name)
    Reflect.deleteProperty(env, name)
  }
  return cleared
}

clearAmbientProxyEnv(process.env)
