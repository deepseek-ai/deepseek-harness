/** File export naming, browser transfer tokens, and native file/application requests. */
import mime from 'mime'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'

/** Browser transfer token type; original bytes stay with the application owner. */
export const FILE_DRAG_TOKEN_TYPE = 'application/x-dsh-file'

/** Opaque preparation identity, minted and resolved only by the desktop main process. */
export type FileDragHandle = Branded<'FileDragHandle'>

/** Caller-minted identity for cancelling a native preparation before it returns a handle. */
export type FileDragRequestId = Branded<'FileDragRequestId'>

/** Provider-owned reference to an application authorized for native dragging. */
export type ApplicationDragReference = Branded<'ApplicationDragReference'>

/** Private Host response; application directories are borrowed without copying or deleting them. */
export type DesktopDragResource = { readonly path: string; readonly sha256: string; readonly size: number }
  | { readonly kind: 'application'; readonly path: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Resolve a provider-issued application reference for the local desktop carrier.
     * @mode serial
     * @param reference Opaque application identity issued by the owning provider.
     * @param signal Preparation cancellation.
     * @returns Authorized application path, or undefined when this listener does not own the reference.
     */
    'desktop/application-drag'(reference: ApplicationDragReference, signal: AbortSignal): Promise<string | undefined>
  }
}

/**
 * Resolve a live application reference through its owning Host plugin.
 * @param ctx Host event context.
 * @param reference Provider-issued application identity.
 * @param signal Preparation cancellation.
 * @returns Authorized bundle path; rejects expired references and cancelled preparations.
 */
export async function resolveApplicationDrag(ctx: Context, reference: ApplicationDragReference, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const path = await ctx.serial('desktop/application-drag', reference, signal)
  signal.throwIfAborted()
  if (path === undefined) throw new Error('Application drag reference expired')
  return path
}

/** Caller-supplied export naming, shared by Web and Desktop. */
export interface DragFileName {
  readonly name?: string | undefined
  readonly mediaType: string
  readonly outputExtension?: string | undefined
}

/** Native preparation copies bytes or asks the Host to authorize borrowing a resource. */
export type DesktopFileSource = (DragFileName & (
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'resource'; readonly address: string; readonly sha256?: string; readonly size?: number }
)) | { readonly kind: 'application'; readonly reference: ApplicationDragReference }

/** Native file operations; no request accepts a raw renderer filesystem path. */
export interface DesktopFileDrag {
  /** Whether this carrier can drag provider-authorized macOS application directories. */
  readonly applications?: boolean
  /**
   * @param source - bytes, a Session resource, or a provider-issued application reference.
   * @param requestId - cancellation identity.
   * @returns a handle, or undefined if the resource needs a byte copy.
   */
  prepare(this: void, source: DesktopFileSource, requestId: FileDragRequestId): Promise<FileDragHandle | undefined>
  /** Cancel unfinished preparation and release its unused resources. @param requestId - preparation identity. */
  cancel(this: void, requestId: FileDragRequestId): void
  /** @param handle - prepared file. @returns whether the OS accepted the drag. */
  start(this: void, handle: FileDragHandle): Promise<boolean>
  /** Release unused preparation; OS-delivered temporary files receive a bounded read grace period. @param handle - prepared file. */
  release(this: void, handle: FileDragHandle): void
}

/**
 * Resolve one platform-safe export filename. Explicit suffix wins; compatible suffixes survive.
 * A known conflicting suffix is replaced from MIME; unknown MIME never rejects a supplied name.
 * @param request - caller name, declared content type, and optional explicit suffix.
 * @returns cleaned filename, with MIME-derived suffix only when needed.
 */
export function resolveDragFileName(request: DragFileName): string {
  const { name = 'file', mediaType, outputExtension } = request
  let clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '') || 'file'
  const dot = clean.lastIndexOf('.')
  const suffix = dot < 0 ? '' : clean.slice(dot + 1)
  const declared = mediaType.replace(/;.*$/su, '').trim().toLowerCase()
  const preferred = mime.getExtension(declared)
  const explicit = outputExtension?.replace(/^\./u, '').replace(/[^a-z\d_-]/giu, '')
  const compatible = mime.getAllExtensions(declared)?.has(suffix.toLowerCase()) === true
  const extension = explicit || (suffix === '' || (preferred !== null && !compatible) ? preferred : suffix)
  if (extension) clean = `${dot < 0 ? clean : clean.slice(0, dot)}.${extension}`
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(clean)) clean = `_${clean}`
  const finalDot = clean.lastIndexOf('.')
  const tail = finalDot < 0 ? '' : clean.slice(finalDot)
  const encoder = new TextEncoder()
  const truncate = (value: string, bytes: number): string => {
    let result = ''
    for (const character of value) {
      const length = encoder.encode(character).length
      if (length > bytes) break
      result += character
      bytes -= length
    }
    return result
  }
  const extensionTail = truncate(tail, 32)
  return `${truncate(finalDot < 0 ? clean : clean.slice(0, finalDot), 255 - encoder.encode(extensionTail).length)}${extensionTail}`
}
