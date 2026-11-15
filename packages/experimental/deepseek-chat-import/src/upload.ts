/**
 * Upload route: one authenticated POST carries the complete export archive,
 * which is buffered in memory, imported, and released when the import ends.
 * The answer streams `application/x-ndjson` progress lines and one outcome
 * line. Nothing from the upload is written to disk.
 */

import { ExportSourceError } from './archive.ts'
import type { DeepseekChatImportWorkspace } from './importer.ts'
import type { DeepseekChatImportFailureReason, DeepseekChatImportLine, DeepseekChatImportResult } from './types.ts'

/** The single import slot of the owning service. */
export interface ImportClaim {
  /** Aborted when the owning service unloads. */
  readonly signal: AbortSignal
  /** Free the slot; called exactly once when the request settles. */
  release(): void
}

/** What the route needs from the owning service. */
export interface UploadRouteHandler {
  /** Largest accepted body, in bytes. */
  readonly maxUploadBytes: number
  /**
   * Take the service's single import slot.
   * @returns the claim, or undefined while another import holds it.
   */
  claim(): ImportClaim | undefined
  /**
   * Resolve the target Workspace.
   * @param workspaceId - id from the request query.
   * @returns the Workspace, or undefined when unknown.
   */
  workspace(workspaceId: string): DeepseekChatImportWorkspace | undefined
  /**
   * Import one buffered archive.
   * @param archive - complete body bytes.
   * @param workspace - resolved target.
   * @param onProgress - Sessions imported so far and the Sessions the import tries to write.
   * @param signal - request lifetime joined with the claim.
   * @returns the import summary.
   */
  import(
    archive: Uint8Array, workspace: DeepseekChatImportWorkspace, onProgress: (done: number, total: number) => void, signal: AbortSignal,
  ): Promise<DeepseekChatImportResult>
  /**
   * Report an import failure that is neither an archive failure nor a cancellation.
   * @param error - the thrown value; the response then ends without an outcome line.
   */
  failed(error: unknown): void
}

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  // Compression middleware honors no-transform, so progress lines are not held back.
  'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff',
}

/**
 * Serve uploads one at a time through the owning service's import slot.
 * @param handler - service operations behind the route.
 * @returns the Fetch handler registered on the Connection route.
 */
export function createUploadRoute(handler: UploadRouteHandler): (request: Request) => Promise<Response> {
  return async (request) => {
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/octet-stream') {
      return new Response('content type must be application/octet-stream', { status: 415 })
    }
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    if (workspaceId === null || workspaceId === '') return new Response('workspaceId is required', { status: 400 })
    const claim = handler.claim()
    if (claim === undefined) {
      await request.body?.cancel()
      return failure('busy', 'another import is running')
    }
    let streaming = false
    try {
      const workspace = handler.workspace(workspaceId)
      if (workspace === undefined) {
        await request.body?.cancel()
        return failure('workspace-not-found', `workspace ${workspaceId} does not exist`)
      }
      const cancel = new AbortController()
      const signal = AbortSignal.any([claim.signal, request.signal, cancel.signal])
      const archive = await readBounded(request, handler.maxUploadBytes, signal)
      if (archive === undefined) return failure('too-large', `the archive exceeds ${handler.maxUploadBytes} bytes`)
      streaming = true
      return new Response(importStream(handler, archive, workspace, claim, cancel, signal), { status: 200, headers: NDJSON_HEADERS })
    } finally {
      if (!streaming) claim.release()
    }
  }
}

/**
 * Run one import behind the response body: progress lines, then one outcome
 * line. Cancelling the body aborts the import; the claim is released when the
 * import settles.
 */
function importStream(
  handler: UploadRouteHandler,
  archive: Uint8Array,
  workspace: DeepseekChatImportWorkspace,
  claim: ImportClaim,
  cancel: AbortController,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let open = true
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const send = (line: DeepseekChatImportLine): void => { if (open) controller.enqueue(encodeLine(line)) }
      const end = (): void => {
        if (open) controller.close()
        open = false
      }
      handler.import(archive, workspace, (done, total) => { send({ type: 'progress', done, total }) }, signal).then(
        (value) => {
          send({ type: 'outcome', outcome: { ok: true, value } })
          end()
        },
        (error: unknown) => {
          if (signal.aborted) {
            end()
          } else if (error instanceof ExportSourceError) {
            send(outcomeLine(error.reason, error.message))
            end()
          } else {
            // Not cancelled, so the body is still open.
            handler.failed(error)
            controller.error(error)
            open = false
          }
        },
      ).finally(() => { claim.release() })
    },
    cancel: () => {
      open = false
      cancel.abort()
    },
  })
}

/**
 * Read the whole body into one buffer sized from a valid `content-length`,
 * growing only when the body is longer than declared; undefined as soon as it
 * would exceed `limit` bytes.
 */
async function readBounded(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (declared > limit) {
    await request.body?.cancel()
    return undefined
  }
  let buffer = new Uint8Array(Number.isSafeInteger(declared) && declared >= 0 ? declared : 0)
  let total = 0
  if (request.body !== null) {
    const reader = request.body.getReader()
    // Cancelling closes the body and ends the pending read even when the body's source then fails to cancel.
    const stop = (): void => { reader.cancel(signal.reason).catch(() => undefined) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        const end = total + chunk.value.byteLength
        if (end > limit) {
          await reader.cancel()
          return undefined
        }
        if (end > buffer.byteLength) {
          const grown = new Uint8Array(Math.min(limit, Math.max(end, buffer.byteLength * 2)))
          grown.set(buffer.subarray(0, total))
          buffer = grown
        }
        buffer.set(chunk.value, total)
        total = end
      }
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }
  signal.throwIfAborted()
  return total === buffer.byteLength ? buffer : buffer.subarray(0, total)
}

function encodeLine(line: DeepseekChatImportLine): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify(line)}\n`)
}

function outcomeLine(reason: DeepseekChatImportFailureReason, message: string): DeepseekChatImportLine {
  return { type: 'outcome', outcome: { ok: false, error: { reason, message } } }
}

function failure(reason: DeepseekChatImportFailureReason, message: string): Response {
  return new Response(encodeLine(outcomeLine(reason, message)), { status: 200, headers: NDJSON_HEADERS })
}
