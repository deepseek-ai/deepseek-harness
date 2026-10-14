/** Native TLS listeners are unavailable in a browser worker's HTTP tunnel. */
import { notAvailableError } from '../../notImplementedFail.ts'

/**
 * Reject native TLS instead of serving plaintext for an HTTPS configuration.
 * @returns Never; a browser worker cannot bind a TLS socket.
 */
export function createServer(): never {
  throw notAvailableError('node:https', 'createServer')
}

/** CommonJS interop marker for the worker module loader. */
export const __esModule = true

/** CommonJS exports for the worker's explicit TLS-listener refusal. */
export default { createServer } satisfies Partial<typeof import('node:https')>
