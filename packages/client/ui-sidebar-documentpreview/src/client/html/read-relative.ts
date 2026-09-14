/** Adapt a Remote relative read without changing its Session or Host path authority. */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { documentFileBytes } from '../rpc.ts'
import type { ReadHtmlRelative } from './pack.ts'

/**
 * Read one dependency relative to the addressed HTML file through the Host.
 * @param address - root HTML file address.
 * @param relativePath - decoded dependency path, resolved only by the Host.
 * @param signal - cancellation shared by the tab and packing operation.
 * @returns the Remote complete-byte result, including declared failures.
 */
export type ReadHtmlRelated = (address: string, relativePath: string, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileBytes>>

/**
 * Bind a package reader to the original HTML file's address.
 * @param readRelated - Remote reader using the Session in the root HTML address.
 * @param address - root HTML file address.
 * @param lifetime - tab lifetime.
 * @returns a reader that strips URL query/fragment, decodes one path, and preserves Host failures.
 */
export function createReadHtmlRelative(readRelated: ReadHtmlRelated, address: string, lifetime: AbortSignal): ReadHtmlRelative {
  return async (reference, signal) => {
    const suffix = reference.search(/[?#]/u)
    const path = decodeURIComponent(suffix === -1 ? reference : reference.slice(0, suffix))
    if (path.length === 0 || /^(?:[a-z][a-z\d+.-]*:|[/\\])/iu.test(path) || path.includes('\0') || path.includes('\\')) {
      throw new Error('HTML dependency must use a relative file path')
    }
    const combined = AbortSignal.any([lifetime, signal])
    combined.throwIfAborted()
    const result = await readRelated(address, path, combined)
    combined.throwIfAborted()
    if (!result.ok) throw new Error(result.error.message)
    return documentFileBytes(result.value)
  }
}
