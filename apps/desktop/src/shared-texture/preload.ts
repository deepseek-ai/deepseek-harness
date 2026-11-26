/** Product-document half of `dshDesktop.textures`: imports Main's texture transfers and reports their lifetime to Main. */
import { sharedTexture } from 'electron'
import { DESKTOP_IPC } from '../ipc.ts'
import type { SharedTextureClientExport, SharedTextureLease } from '@deepseek-ai/dsh-shared-texture/types'
import type { SharedTextureRendererImport, SharedTextureTransferMessage } from './transfer.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

function parseTransferData(value: unknown): Electron.SharedTextureTransfer | undefined {
  if (!isRecord(value) || !isRecord(value.codedSize) || !isRecord(value.visibleRect)) return undefined
  const { transfer, syncToken, pixelFormat, timestamp } = value
  const { width, height } = value.codedSize
  const { x, y, width: visibleWidth, height: visibleHeight } = value.visibleRect
  if (typeof transfer !== 'string' || typeof syncToken !== 'string' || typeof pixelFormat !== 'string' || !isNumber(timestamp)
    || !isNumber(width) || !isNumber(height) || !isNumber(x) || !isNumber(y) || !isNumber(visibleWidth) || !isNumber(visibleHeight)) {
    return undefined
  }
  return {
    transfer, syncToken, pixelFormat, timestamp, codedSize: { width, height },
    visibleRect: { x, y, width: visibleWidth, height: visibleHeight },
  }
}

/** Main is the only sender on the channel; a transfer without an identifier cannot be answered. */
function parseTransfer(value: unknown): { id: number; message: SharedTextureTransferMessage | undefined } | undefined {
  if (!isRecord(value) || typeof value.id !== 'number') return undefined
  const transfer = parseTransferData(value.transfer)
  const { metadata } = value
  return { id: value.id, message: transfer === undefined || typeof metadata !== 'string' ? undefined : { id: value.id, transfer, metadata } }
}

/** The Host serializes metadata with `JSON.stringify`, and Main forwards the text; an empty text carries no metadata. */
function parseMetadata(text: string): { value: unknown } | undefined {
  if (text === '') return { value: null }
  try {
    return { value: JSON.parse(text) }
  } catch (_invalidJson) {
    return undefined
  }
}

/** The application preload's `ipcRenderer`, narrowed to the operations the bridge uses. */
export interface SharedTextureRendererIpc {
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  send(channel: string, ...args: unknown[]): void
}

/**
 * Receive Main's texture transfers and return the operations exposed as `dshDesktop.textures`. Only the application
 * preload calls this. For each texture the document reports its import result to Main at once, and its release only
 * after the consumer released the lease and the GPU work that used the texture completed. A transfer whose metadata is
 * not JSON, or that arrives while no consumer is registered, is refused before import, so Main releases it at once.
 * @param ipc - The application preload's `ipcRenderer`.
 * @returns Texture consumption; native handles stay in Electron.
 */
export function createSharedTextureClientExport(ipc: SharedTextureRendererIpc): SharedTextureClientExport {
  let listener: ((lease: SharedTextureLease) => void) | undefined
  const report = (id: number, result: SharedTextureRendererImport): void => { ipc.send(DESKTOP_IPC.sharedTextureImported, id, result) }
  ipc.on(DESKTOP_IPC.sharedTexture, (_event, value: unknown) => {
    const parsed = parseTransfer(value)
    if (parsed === undefined) {
      console.error('Desktop shared texture: ignored a transfer without an identifier')
      return
    }
    const { id, message } = parsed
    if (message === undefined) {
      report(id, { error: 'Invalid shared-texture transfer' })
      return
    }
    const metadata = parseMetadata(message.metadata)
    if (metadata === undefined) {
      report(id, { error: 'Shared-texture metadata is not valid JSON' })
      return
    }
    const consumer = listener
    if (consumer === undefined) {
      report(id, { error: 'Shared textures have no consumer' })
      return
    }
    let imported: Electron.SharedTextureImportedSubtle | undefined
    try {
      imported = sharedTexture.subtle.finishTransferSharedTexture(message.transfer)
      report(id, imported.getFrameCreationSyncToken())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (imported === undefined) report(id, { error: message })
      else {
        try { report(id, { error: message, invalidated: true }) } finally { imported.release() }
      }
      return
    }
    const texture = imported
    let frame: VideoFrame | undefined
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      frame?.close()
      texture.release(() => { ipc.send(DESKTOP_IPC.sharedTextureReleased, id) })
    }
    try {
      frame = texture.getVideoFrame()
      consumer({ metadata: metadata.value, frame, release })
    } catch (error) {
      release()
      throw error
    }
  })
  return {
    onFrame(next) {
      if (listener !== undefined) throw new Error('Shared textures already have a consumer')
      listener = next
      return () => {
        if (listener === next) listener = undefined
      }
    },
  }
}
