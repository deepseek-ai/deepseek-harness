/** Parent-side setup for one explicitly requested inherited control pipe. */

import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import type { Duplex, Readable, Writable } from 'node:stream'

/**
 * Read the optional extra pipe from Node's stdio tuple.
 * @param child - child whose requested extra pipe was allocated by Node.
 * @param control - requested transport, or undefined when absent.
 * @returns the parent duplex endpoint, absent when not requested or native startup failed.
 */
export function controlPipe(
  child: { readonly stdio: ReadonlyArray<Readable | Writable | null | undefined> },
  control?: 'pipe',
): Duplex | undefined {
  // Node's type declaration names only the first five descriptor slots.
  const streams: ReadonlyArray<Readable | Writable | null | undefined> = child.stdio
  return control === 'pipe' ? streams[SUBPROCESS_CONTROL_FD] as Duplex | undefined : undefined
}

/**
 * Stamp the private marker on a fresh child environment after rejecting a caller override.
 * @param env - newly materialized child environment, owned by the caller.
 * @param control - requested control transport, or undefined when absent.
 * @returns the same environment with the provider-owned launch marker when requested.
 */
export function controlEnvironment<T extends NodeJS.ProcessEnv>(env: T, control?: 'pipe'): T {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === SUBPROCESS_CONTROL_ENV && value !== undefined) {
      throw new Error(`${SUBPROCESS_CONTROL_ENV} is reserved for subprocess control-channel setup`)
    }
  }
  if (control === 'pipe') Object.assign(env, { [SUBPROCESS_CONTROL_ENV]: 'pipe' })
  return env
}
