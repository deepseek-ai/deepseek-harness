/** Adapt a relative workspace read without changing its Session or Host path authority. */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { DocumentFileBytes } from '../rpc.ts'
import type { ReadHtmlRelative } from './pack.ts'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { hostFileOf } from '../rpc.ts'

/**
 * Read one dependency relative to the addressed HTML file through the Host.
 * @param address - root HTML file address.
 * @param relativePath - decoded dependency path, resolved only by the Host.
 * @param signal - cancellation shared by the tab and packing operation.
 * @returns the complete-byte result, including declared failures.
 */
export type ReadHtmlRelated = (address: string, relativePath: string, signal: AbortSignal) => Promise<RemoteResult<DocumentFileBytes>>

/**
 * Bind a package reader to the original HTML file's address.
 * @param readRelated - workspace reader using the Session in the root HTML address.
 * @param address - root HTML file address.
 * @param lifetime - tab lifetime.
 * @param addResource - subscribes to the dependency path reported by the Host.
 * @returns a reader that strips URL query/fragment, decodes one path, and preserves Host failures.
 */
export function createReadHtmlRelative(
  readRelated: ReadHtmlRelated,
  address: string,
  lifetime: AbortSignal,
  addResource: (address: string) => void,
): ReadHtmlRelative {
  return async (reference, signal) => {
    const suffix = reference.search(/[?#]/u)
    const path = decodeURIComponent(suffix === -1 ? reference : reference.slice(0, suffix))
    if (path.length === 0 || /^(?:[a-z][a-z\d+.-]*:|[/\\])/iu.test(path) || path.includes('\0') || path.includes('\\')) {
      throw new Error('HTML dependency must use a relative file path')
    }
    const combined = AbortSignal.any([lifetime, signal])
    combined.throwIfAborted()
    const file = hostFileOf(address)
    const result = await readRelated(address, path, combined)
    combined.throwIfAborted()
    if (!result.ok) {
      if ('path' in result.error.details && typeof result.error.details.path === 'string') {
        addResource(sessionFileAddress(file.sessionId, result.error.details.path))
      }
      throw new Error(result.error.message)
    }
    addResource(sessionFileAddress(file.sessionId, result.value.absolutePath))
    return result.value
  }
}
