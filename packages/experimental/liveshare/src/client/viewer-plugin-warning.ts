/**
 * Surface a viewer-facing notice when a plugin calls an owner-only route.
 *
 * A plugin's RPC error may be swallowed by that plugin's own UI. This page-level notice names the
 * plugin once per page so the reader learns why a panel is empty; it never retries or changes the
 * call itself.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-plugin-warning
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ViewerTranslate } from './locales.ts'

/** Plugin names already announced on this page. */
const announced = new Set<string>()

/**
 * Read the plugin segment of one owner-only Fetch route.
 * @param input - Fetch input.
 * @returns The plugin namespace, or undefined for another request.
 */
function pluginOf(input: RequestInfo | URL): string | undefined {
  let url: URL
  try {
    url = new URL(input instanceof Request ? input.url : String(input), location.href)
  } catch {
    /* v8 ignore next -- a malformed URL is ignored before it reaches fetch. */
    return undefined
  }
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return undefined
  const plugin = url.pathname.split('/')[2]
  return plugin === undefined || plugin === '' ? undefined : plugin
}

/**
 * Read the plugin segment of one RPC endpoint.
 * @param endpoint - Channel-relative endpoint such as `timeline/watch`.
 * @returns The plugin namespace.
 */
function pluginOfEndpoint(endpoint: string): string | undefined {
  const plugin = endpoint.split('/')[0]
  return plugin === undefined || plugin === '' ? undefined : plugin
}

/**
 * Whether one response body is LiveShare's owner-route refusal.
 * @param response - The response to inspect.
 * @returns True for the stable refusal code.
 */
async function ownerRouteRefused(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  try {
    const body: unknown = await response.clone().json()
    return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'owner-route-not-shared'
  } catch {
    return false
  }
}

/**
 * Whether one RPC failure carries the owner-route refusal.
 * @param error - Connection RPC failure.
 * @returns True for the stable code.
 */
function isOwnerRouteFailure(error: unknown): boolean {
  if (error instanceof Error && error.message.includes('owner-route-not-shared')) return true
  return typeof error === 'object' && error !== null
    && JSON.stringify(error).includes('owner-route-not-shared')
}

/** Draw the one notice for a plugin. */
function showNotice(document: Document, plugin: string, t: ViewerTranslate): void {
  const notice = document.createElement('div')
  notice.setAttribute('role', 'status')
  notice.dataset.livesharePluginWarning = plugin
  notice.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:1000',
    'max-width:360px', 'padding:10px 12px', 'border-radius:8px',
    'background:var(--dsw-alias-bg-elevated,#fff)', 'color:var(--dsw-alias-label-primary,#111)',
    'border:1px solid var(--dsw-alias-border-l2,#ddd)', 'box-shadow:0 6px 20px rgba(0,0,0,.16)',
    'font-size:12px', 'line-height:1.45',
  ].join(';')
  notice.textContent = t('viewer.pluginUnsupported', { plugin })
  document.body.append(notice)
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', t('viewer.dismiss'))
  close.style.cssText = 'margin-left:8px;border:0;background:none;color:inherit;cursor:pointer'
  close.addEventListener('click', () => { notice.remove() })
  notice.append(close)
}

/**
 * Announce one plugin at most once on this page.
 * @param document - Page document that owns the notice.
 * @param plugin - Plugin namespace.
 * @param t - Viewer copy.
 */
export function reportViewerPluginWarning(document: Document, plugin: string, t: ViewerTranslate): void {
  if (announced.has(plugin)) return
  announced.add(plugin)
  showNotice(document, plugin, t)
}

/**
 * Observe same-origin plugin RPC responses and name each failing plugin once.
 * @param document - Page document that owns the notice.
 * @param t - Viewer copy.
 * @returns Disposer restoring the global fetch and removing notices.
 */
export function installViewerPluginWarnings(document: Document, t: ViewerTranslate): () => void {
  const original = globalThis.fetch
  const patched: typeof fetch = async (input, init) => {
    const response = await original(input, init)
    const plugin = pluginOf(input)
    if (plugin !== undefined && await ownerRouteRefused(response)) {
      reportViewerPluginWarning(document, plugin, t)
    }
    return response
  }
  globalThis.fetch = patched
  return () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
    for (const notice of document.querySelectorAll('[data-liveshare-plugin-warning]')) notice.remove()
    announced.clear()
  }
}

/**
 * Observe the Connection's logical RPC calls, which browser transports carry outside `fetch`.
 * @param connection - Viewer page Connection.
 * @param document - Page document that owns the notice.
 * @param t - Viewer copy.
 * @returns Disposer restoring the original call.
 */
export function installViewerRpcWarnings(
  connection: { readonly rpc?: ConnectionHandle['rpc'] },
  document: Document,
  t: ViewerTranslate,
): () => void {
  const rpc = connection.rpc
  if (rpc === undefined) return () => {}
  const original = rpc.call.bind(rpc)
  const patched = async (
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): ReturnType<typeof rpc.call> => {
    try {
      const result = await original(channel, endpoint, payload, signal)
      if (!result.ok && isOwnerRouteFailure(result.error)) {
        const plugin = pluginOfEndpoint(endpoint)
        if (plugin !== undefined) reportViewerPluginWarning(document, plugin, t)
      }
      return result
    } catch (error) {
      if (isOwnerRouteFailure(error)) {
        const plugin = pluginOfEndpoint(endpoint)
        if (plugin !== undefined) reportViewerPluginWarning(document, plugin, t)
      }
      throw error
    }
  }
  try {
    rpc.call = patched
  } catch {
    // A frozen Connection is still readable; the fetch observer covers its HTTP carrier.
    return () => {}
  }
  return () => {
    if (rpc.call === patched) rpc.call = original
  }
}
