/** Native copy drags authorized only for the product main frame and the active Host. */
import { createHash } from 'node:crypto'
import { createReadStream, statSync, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type NativeImage } from 'electron'
import { resolveDragFileName, type DesktopFileSource, type FileDragHandle } from '@deepseek-ai/dsh-util-file-drag'
import { DESKTOP_IPC } from './ipc.ts'
import { DragFiles } from './file-drag-files.ts'

interface LocalResource { readonly path: string; readonly size: number; readonly sha256: string }

function requestOf(value: unknown): DesktopFileSource {
  if (typeof value !== 'object' || value === null || !('kind' in value)
    || !('mediaType' in value) || typeof value.mediaType !== 'string'
    || ('name' in value && value.name !== undefined && typeof value.name !== 'string')
    || ('outputExtension' in value && value.outputExtension !== undefined && typeof value.outputExtension !== 'string')) throw new Error('Invalid file drag request')
  const naming = {
    mediaType: value.mediaType, name: 'name' in value ? value.name as string | undefined : undefined,
    outputExtension: 'outputExtension' in value ? value.outputExtension as string | undefined : undefined,
  }
  if (value.kind === 'bytes' && 'bytes' in value && value.bytes instanceof Uint8Array) return { kind: 'bytes', bytes: value.bytes, ...naming }
  if (value.kind === 'resource' && 'address' in value && typeof value.address === 'string'
    && (!('sha256' in value) || (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256)))
    && (!('size' in value) || (typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0))) {
    return { kind: 'resource', address: value.address, ...naming,
      ...('sha256' in value ? { sha256: value.sha256 as string } : {}),
      ...('size' in value ? { size: value.size as number } : {}) }
  }
  throw new Error('Invalid file drag request')
}

function sameVersion(before: Stats, after: Stats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.size === after.size
}

async function verifiedVersion(resource: LocalResource, signal: AbortSignal): Promise<Stats | undefined> {
  signal.throwIfAborted()
  const info = await stat(resource.path)
  if (!info.isFile() || info.size !== resource.size) return undefined
  const hash = createHash('sha256')
  const stream = createReadStream(resource.path, { signal })
  const chunks: AsyncIterable<unknown> = stream
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new Error('File stream returned non-binary data')
    hash.update(chunk)
  }
  const after = await stat(resource.path)
  return sameVersion(info, after) && hash.digest('hex') === resource.sha256 ? after : undefined
}

async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([operation, cancelled.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

/**
 * Register file preparation and native dragging.
 * @param owner - shared product sender authorization, returning its window.
 * @param resolveResource - cancellable private Host authorization; renderer paths are never used directly.
 * @returns cleanup aborting resource reads and awaiting tracked writes/removals without waiting for the system icon service.
 */
export function installDesktopFileDrag(
  owner: (event: IpcMainInvokeEvent) => BrowserWindow,
  resolveResource: (address: string, signal: AbortSignal) => Promise<LocalResource | null>,
): () => Promise<void> {
  let disposed = false
  const preparations = new Map<string, AbortController>()
  const files = new DragFiles(app.getPath('temp'))
  const pending = new Set<Promise<FileDragHandle | undefined>>()
  const icons = new Map<string, NativeImage>()
  const borrowed = new Map<string, { resource: LocalResource; version: Stats }>()
  const authorize = (event: IpcMainInvokeEvent): BrowserWindow => {
    if (disposed) throw new Error('File transfer closed')
    return owner(event)
  }
  const prepare = async (event: IpcMainInvokeEvent, value: unknown, signal: AbortSignal): Promise<FileDragHandle | undefined> => {
    authorize(event)
    const source = requestOf(value)
    let handle: FileDragHandle
    if (source.kind === 'bytes') handle = await files.prepare(source.bytes, source)
    else {
      const resource = await cancellable(resolveResource(source.address, signal), signal)
      authorize(event)
      if (resource === null || basename(resource.path) !== resolveDragFileName(source)
        || (source.sha256 !== undefined && source.sha256 !== resource.sha256)
        || (source.size !== undefined && source.size !== resource.size)) return undefined
      const version = await verifiedVersion(resource, signal)
      if (version === undefined) return undefined
      handle = files.borrow(resource.path)
      borrowed.set(handle, { resource, version })
    }
    try {
      signal.throwIfAborted()
      const file = files.take(handle, false)
      if (file === undefined) throw new Error('File transfer closed')
      const icon = await cancellable(app.getFileIcon(file, { size: 'normal' }), signal)
      authorize(event)
      icons.set(handle, icon)
      return handle
    } catch (error) {
      borrowed.delete(handle)
      await files.release(handle)
      throw error
    }
  }
  ipcMain.handle(DESKTOP_IPC.fileDragPrepare, (event, source: unknown, requestId: unknown) => {
    authorize(event)
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128 || preparations.has(requestId)) throw new Error('Invalid file preparation identity')
    const abort = new AbortController()
    preparations.set(requestId, abort)
    const operation = prepare(event, source, abort.signal).finally(() => { preparations.delete(requestId) })
    pending.add(operation)
    void operation.then(() => { pending.delete(operation) }, () => { pending.delete(operation) })
    return operation
  })
  ipcMain.handle(DESKTOP_IPC.fileDragCancel, (event, requestId: unknown) => {
    authorize(event)
    if (typeof requestId === 'string') preparations.get(requestId)?.abort(new Error('File preparation cancelled'))
  })
  ipcMain.handle(DESKTOP_IPC.fileDragStart, (event, handle: unknown) => {
    const window = authorize(event)
    const icon = typeof handle === 'string' ? icons.get(handle) : undefined
    if (icon === undefined || typeof handle !== 'string') return false
    const file = files.take(handle, false)
    if (file === undefined) return false
    try {
      const original = borrowed.get(handle)
      if (original !== undefined && !sameVersion(original.version, statSync(original.resource.path))) throw new Error('File changed before dragging')
      authorize(event)
      window.webContents.startDrag({ file, icon })
      files.take(handle)
      icons.delete(handle)
      borrowed.delete(handle)
      return true
    } catch (_error) {
      icons.delete(handle)
      borrowed.delete(handle)
      void files.release(handle).catch((error: unknown) => { console.error(error) })
      return false
    }
  })
  ipcMain.handle(DESKTOP_IPC.fileDragRelease, async (event, handle: unknown) => {
    authorize(event)
    if (typeof handle === 'string') { icons.delete(handle); borrowed.delete(handle) }
    await files.release(handle)
  })
  return async () => {
    if (!disposed) {
      disposed = true
      for (const abort of preparations.values()) abort.abort(new Error('File transfer closed'))
      ipcMain.removeHandler(DESKTOP_IPC.fileDragPrepare)
      ipcMain.removeHandler(DESKTOP_IPC.fileDragCancel)
      ipcMain.removeHandler(DESKTOP_IPC.fileDragStart)
      ipcMain.removeHandler(DESKTOP_IPC.fileDragRelease)
    }
    await Promise.allSettled(pending)
    icons.clear()
    borrowed.clear()
    await files.dispose()
  }
}
