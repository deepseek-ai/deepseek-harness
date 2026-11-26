/** Export one texture from Chromium's Windows compositor so Main can identify the compositor's adapter. */
import { app, BrowserWindow } from 'electron'

/** A compositor-exported texture held open, with its hidden window, until released. */
export interface SharedTextureProbeTexture {
  /** Main-local NT handle of the exported texture. */
  readonly ntHandle: Buffer
  /** Return the texture to Chromium and destroy its window; idempotent. */
  release(): void
}

/**
 * Await Chromium graphics initialization and export one compositor texture within one deadline.
 * @param timeoutMs - Total graphics initialization and export deadline.
 * @param signal - Cancels the probe when the owning Host or window closes.
 * @returns A held texture, or null when Chromium does not composite through Direct3D 11.
 */
export async function probeSharedTexture(timeoutMs: number, signal: AbortSignal): Promise<SharedTextureProbeTexture | null> {
  if (process.platform !== 'win32' || signal.aborted) return null
  const lifetime = new AbortController()
  const abort = (): void => { lifetime.abort() }
  const timer = setTimeout(abort, timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (!await graphicsReady(lifetime.signal)) return null
    for (let attempt = 0; attempt < 2 && !lifetime.signal.aborted; attempt++) {
      const texture = await exportTexture(timeoutMs / 2, lifetime.signal)
      if (texture !== null) return texture
    }
    return null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** Feature status is usable after complete GPU information has been collected. */
function graphicsReady(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (available: boolean): void => {
      signal.removeEventListener('abort', abort)
      resolve(available)
    }
    const abort = (): void => { finish(false) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { finish(false); return }
    void (async () => {
      try {
        const info = await app.getGPUInfo('complete')
        if (signal.aborted) return
        const d3d11 = typeof info === 'object' && info !== null && 'auxAttributes' in info
          && typeof info.auxAttributes === 'object' && info.auxAttributes !== null
          && 'displayType' in info.auxAttributes && info.auxAttributes.displayType === 'ANGLE_D3D11'
        finish(d3d11 && app.getGPUFeatureStatus().gpu_compositing.startsWith('enabled'))
      } catch (_error) {
        // A failed GPU process cannot export Direct3D textures.
        finish(false)
      }
    })()
  })
}

/** Paint one offscreen window with shared textures; the first exported texture and its window are kept until released. */
function exportTexture(timeoutMs: number, signal: AbortSignal): Promise<SharedTextureProbeTexture | null> {
  return new Promise((resolve) => {
    let window: BrowserWindow | undefined
    let settled = false
    const destroy = (): void => {
      if (window !== undefined && !window.isDestroyed()) window.destroy()
    }
    const finish = (texture: SharedTextureProbeTexture | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (texture === null) destroy()
      resolve(texture)
    }
    const timer = setTimeout(() => { finish(null) }, timeoutMs)
    const abort = (): void => { finish(null) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      window = new BrowserWindow({ show: false, width: 16, height: 16, webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: { useSharedTexture: true },
      } })
      window.on('closed', () => { finish(null) })
      window.webContents.on('render-process-gone', () => { finish(null) })
      window.webContents.on('paint', (event) => {
        const texture = event.texture
        if (texture === undefined) return
        const ntHandle = texture.textureInfo.handle.ntHandle
        if (ntHandle === undefined || settled) { texture.release(); return }
        let released = false
        finish({ ntHandle, release: () => {
          if (released) return
          released = true
          texture.release()
          destroy()
        } })
      })
      void window.loadURL('data:text/html,<html><head><meta http-equiv="Content-Security-Policy" content="default-src %27none%27"></head><body>x</body></html>')
        .catch(() => { finish(null) })
    } catch (_error) {
      // Hardware acceleration can be unavailable before a probe window exists.
      finish(null)
    }
  })
}
