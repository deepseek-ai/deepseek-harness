/** Trusted-window Chromium downloads and clipboard fallback reads. */
import { app, ipcMain, session } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { closeSync, openSync, rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { resolveDragFileName } from '@deepseek-ai/dsh-util-file-drag'
import { randomUUID } from 'node:crypto'
import type { FileSaveResult } from '@deepseek-ai/dsh-client-ui-file-actions/types'
import { DESKTOP_IPC } from './ipc.ts'
import { resolveDurationMs } from './duration-env.ts'

/** @param value - untrusted IPC input. @returns captured URL and destination policy. */
function saveRequest(value: unknown): { url: URL; name?: string; mediaType?: string; mode: 'download' | 'saveAs' } {
  if (typeof value !== 'object' || value === null
    || !('url' in value) || typeof value.url !== 'string'
    || ('name' in value && typeof value.name !== 'string')
    || ('mediaType' in value && typeof value.mediaType !== 'string')
    || !('mode' in value) || (value.mode !== 'download' && value.mode !== 'saveAs')) throw new Error('Invalid file save request')
  const url = new URL(value.url)
  if (!['https:', 'http:', 'blob:', 'data:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported file source')
  return { url, mode: value.mode,
    ...'name' in value ? { name: value.name as string } : {},
    ...'mediaType' in value ? { mediaType: value.mediaType as string } : {},
  }
}

/**
 * Install trusted-window original-file operations.
 * @param assertOwner - rejects shell pages, subframes, and unowned windows.
 * @param hostUrl - current application Host excluded from image reads.
 */
export function installFileActions(
  assertOwner: (event: IpcMainInvokeEvent) => BrowserWindow, hostUrl: () => string | undefined = () => undefined,
): void {
  const timeoutMs = resolveDurationMs(process.env, 'DSH_DESKTOP_IMAGE_READ_TIMEOUT_MS', 30_000)
  const maxBytes = Number(process.env.DSH_DESKTOP_IMAGE_READ_MAX_BYTES ?? 64 * 1024 * 1024)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('DSH_DESKTOP_IMAGE_READ_MAX_BYTES must be a positive integer')
  const pending = new Map<string, {
    event: IpcMainInvokeEvent
    owner: BrowserWindow
    request: ReturnType<typeof saveRequest>
    finish: (result: FileSaveResult | Error) => void
    started: () => void
    item?: Electron.DownloadItem
  }>()
  session.defaultSession.on('will-download', (_event, item, contents) => {
    const url = item.getURLChain()[0]
    if (url === undefined || !new URL(url).hash.startsWith('#dsh-download=')) return
    const entry = pending.get(url)
    if (entry === undefined || entry.owner.webContents !== contents) { item.cancel(); return }
    entry.started()
    entry.item = item
    let reserved: string | undefined
    try {
      assertOwner(entry.event)
      const name = resolveDragFileName({
        name: entry.request.name ?? item.getFilename(),
        mediaType: item.getMimeType() || entry.request.mediaType || '',
      })
      let destination = join(app.getPath('downloads'), name)
      if (entry.request.mode === 'saveAs') {
        item.setSaveDialogOptions({ defaultPath: destination, properties: ['showOverwriteConfirmation', 'createDirectory'] })
      } else {
        const extension = extname(destination)
        const stem = destination.slice(0, destination.length - extension.length)
        for (let index = 0; ; index++) {
          destination = index === 0 ? `${stem}${extension}` : `${stem} (${index})${extension}`
          try { closeSync(openSync(destination, 'wx')); break }
          catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') continue
            throw error
          }
        }
        reserved = destination
        item.setSavePath(destination)
      }
      item.once('done', (_event, state) => {
        try {
          if (state !== 'completed') {
            if (reserved !== undefined) rmSync(reserved, { force: true })
            entry.finish(state === 'cancelled' ? { status: 'cancelled' } : new Error('File download interrupted'))
            return
          }
          if (!pending.has(url)) return
          assertOwner(entry.event)
          entry.finish({ status: 'saved', path: item.getSavePath() })
        } catch (error) { entry.finish(error instanceof Error ? error : new Error('File download unavailable')) }
      })
    } catch (error) {
      item.cancel()
      try { if (reserved !== undefined) rmSync(reserved, { force: true }) }
      catch (cleanupError) {
        entry.finish(new AggregateError([error, cleanupError], 'File download failed and its partial file could not be removed'))
        return
      }
      entry.finish(error instanceof Error ? error : new Error('File download unavailable'))
    }
  })
  const downloadTimeoutMs = resolveDurationMs(process.env, 'DSH_DESKTOP_FILE_DOWNLOAD_TIMEOUT_MS', 300_000)
  ipcMain.handle(DESKTOP_IPC.fileSave, (event, value: unknown): Promise<FileSaveResult> => {
    const owner = assertOwner(event)
    const request = saveRequest(value)
    // Fragments do not change the fetched resource; each native request has its own completion identity.
    request.url.hash = `dsh-download=${randomUUID()}`
    const url = request.url.href
    return new Promise((resolve, reject) => {
      const contents = owner.webContents
      const finish = (result: FileSaveResult | Error): void => {
        if (!pending.delete(url)) return
        clearTimeout(timer)
        owner.removeListener('closed', cancel)
        contents.removeListener('did-start-navigation', navigate)
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      const cancel = (): void => {
        const item = pending.get(url)?.item
        finish({ status: 'cancelled' })
        item?.cancel()
      }
      const navigate = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
        if (mainFrame && !inPlace) cancel()
      }
      const timer = setTimeout(() => {
        const item = pending.get(url)?.item
        finish(new Error('File download timed out'))
        item?.cancel()
      }, downloadTimeoutMs)
      pending.set(url, { event, owner, request, finish, started: () => { clearTimeout(timer) } })
      owner.once('closed', cancel)
      contents.on('did-start-navigation', navigate)
      try { contents.downloadURL(url) }
      catch (error) { finish(error instanceof Error ? error : new Error('File download unavailable')) }
    })
  })
  ipcMain.handle(DESKTOP_IPC.clipboardImageRead, async (event, value: unknown) => {
    const owner = assertOwner(event)
    if (typeof value !== 'string') throw new Error('Invalid image URL')
    const checkedUrl = (value: string): URL => {
      const url = new URL(value)
      const host = hostUrl()
      const application = host === undefined ? undefined : new URL(host)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || application !== undefined && url.port === application.port
        && (url.hostname === application.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new Error('Invalid image URL')
      }
      return url
    }
    let url = checkedUrl(value)
    const contents = owner.webContents
    const lifetime = new AbortController()
    const abort = (): void => { lifetime.abort() }
    owner.once('closed', abort)
    const navigate = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (mainFrame && !inPlace) abort()
    }
    contents.on('did-start-navigation', navigate)
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)])
      let response: Response
      for (let redirects = 0; ; redirects++) {
        response = await fetch(url, { signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (redirects >= 20 || location === null) throw new Error('Invalid image redirect')
        url = checkedUrl(new URL(location, url).href)
      }
      if (!response.ok) throw new Error('Original image unavailable')
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('Original image unavailable')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > maxBytes) throw new Error('Original image exceeds the download limit')
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      assertOwner(event)
      lifetime.signal.throwIfAborted()
      return { bytes: new Uint8Array(Buffer.concat(chunks)), mediaType: response.headers.get('content-type') ?? '' }
    } finally {
      owner.removeListener('closed', abort)
      contents.removeListener('did-start-navigation', navigate)
    }
  })
}
