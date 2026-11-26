/** Electron Main's single entry to Desktop shared textures: the presenter, its addons, and the Host channel. */
import type { BrowserWindow } from 'electron'
import type { DesktopHostChannel } from '../host-process.ts'
import { createSharedTextureChannel } from './channel.ts'
import { loadSharedTextureIngressBindings, sharedTextureHopAddonPath, sharedTextureIngressAddonPath } from './ingress.ts'
import { DesktopSharedTexturePresenter, type SharedTextureResetOptions } from './presenter.ts'

/** Shared textures for the product window, as Electron Main wires them. */
export interface DesktopSharedTextures {
  /** Attach to every spawned Desktop Host. */
  readonly channel: DesktopHostChannel
  /**
   * Window-level cleanup after a committed cross-document navigation, renderer or GPU loss, or window closure; textures
   * the document still held settle as invalidated, and the ingress stays with the Host.
   * @param options - Pass `gpuProcessGone` after Chromium's GPU process exited, so the next adapter query reads the
   *   compositor's adapter again.
   * @returns Completion after pending operations settle.
   */
  reset(options?: SharedTextureResetOptions): Promise<void>
  /**
   * Host-level teardown: {@link reset}, then close the ingress of the stopped or failed Host.
   * @returns Completion of ingress teardown.
   */
  dispose(): Promise<void>
  /**
   * Apply the product renderer's import result for a sent texture; call only for messages from the product main frame.
   * @param id - Presentation identifier the renderer received with the texture.
   * @param result - The renderer's unvalidated report.
   */
  rendererImported(id: number, result: unknown): void
  /**
   * Record that the product renderer released a sent texture; call only for messages from the product main frame.
   * @param id - Presentation identifier the renderer received with the texture.
   */
  rendererReleased(id: number): void
}

/**
 * Create Main's shared textures for the product window.
 * @param appPath - Application directory holding `lib/native`; the ingress addon loads on the first Host query.
 * @param window - Current product window, or undefined while none exists.
 * @returns The Host channel and the cleanup operations.
 */
export function createDesktopSharedTextures(appPath: string, window: () => BrowserWindow | undefined): DesktopSharedTextures {
  const presenter = new DesktopSharedTexturePresenter(window, sharedTextureHopAddonPath(appPath),
    () => loadSharedTextureIngressBindings(sharedTextureIngressAddonPath(appPath)))
  return {
    channel: createSharedTextureChannel(presenter.request.bind(presenter)),
    reset: options => presenter.reset(options),
    dispose: () => presenter.dispose(),
    rendererImported: (id, result) => { presenter.rendererImported(id, result) },
    rendererReleased: (id) => { presenter.rendererReleased(id) },
  }
}
