/** Assemble Electron navigation and presentation behind the shared BrowserPage interface. */
import type { DesktopBrowserBridge } from '../../types.ts'
import type { BrowserPage, BrowserPageOptions } from '../browser/BrowserPage.ts'
import { ElectronWebViewImpl } from './ElectronWebViewImpl.ts'
import { ElectronWebviewPresentation } from './ElectronWebviewPresentation.ts'

/**
 * Assemble an idle Electron provider; guest creation waits for mounting and navigation.
 * @param options - checkpoint and source-tab callbacks.
 * @param bridge - desktop-only transport.
 * @param workspace - storage account resolver.
 * @returns separate navigation and presentation faces.
 */
export function createElectronPage(options: BrowserPageOptions, bridge: DesktopBrowserBridge,
  workspace: (signal: AbortSignal) => Promise<string>): BrowserPage {
  const presentation = new ElectronWebviewPresentation({
    mounted: () => { frame.attach() },
    unmounted: () => { frame.detach() },
  })
  const frame = new ElectronWebViewImpl(options, bridge, workspace, presentation)
  return { frame, presentation }
}
