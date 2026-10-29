/**
 * Owner-side resources of the served viewer page: the rendered index, shell assets, and client
 * plugin bundles, read for a viewer the Relay already authenticated.
 *
 * The page is the owner's own Web shell, so every byte comes from the services that serve the owner's
 * page: the webserver's resource read for the index and shell assets, and the client module registry for
 * plugin bundles. The resource read receives the reader's own Peer, so the index renders that reader's
 * opening access snapshot and the page offers only what it may call from its first render.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-assets
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { ViewerAnswer, ViewerAssetBody } from '../viewer-channel.ts'

/** Placeholder origin the page-relative path is resolved against; only the path and query are read. */
const ASSET_ORIGIN = 'http://viewer.invalid/'

/**
 * Read one served-page resource.
 * @param ctx - Owner Host context carrying the webserver and the client module registry.
 * @param path - Validated page-relative path and query: the index, `assets/...`, or `plugins/...`.
 * @param peer - The reader's own Peer; the page resource renders the opening access rows for it.
 * @returns The answer the Relay serves for that path.
 */
export async function readViewerAsset(ctx: Context, path: string, peer: PeerScope): Promise<ViewerAnswer> {
  const target = new URL(path, ASSET_ORIGIN)
  if (path.startsWith('plugins/')) {
    const modules = ctx.get('clientModules')
    if (modules === undefined) return unavailable()
    const response = await modules.fetchBundle(new Request(target))
    if (!response.ok) return { status: response.status, body: { error: 'asset-not-found' } }
    return assetAnswer(
      response.headers.get('content-type') ?? 'text/javascript; charset=utf-8',
      new Uint8Array(await response.arrayBuffer()),
    )
  }
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return unavailable()
  // The URL carries what an HTTP request would: the resource reads only its path and query, so a
  // placeholder origin is enough and no listener address or protocol is needed here.
  const response = await webServer.readResource(new Request(target), peer)
  if (!response.ok) return { status: response.status, body: { error: 'asset-not-found' } }
  return assetAnswer(
    response.headers.get('content-type') ?? 'application/octet-stream',
    new Uint8Array(await response.arrayBuffer()),
  )
}

function assetAnswer(contentType: string, body: Uint8Array): ViewerAnswer {
  return { status: 200, body: { contentType, base64: Buffer.from(body).toString('base64') } satisfies ViewerAssetBody }
}

function unavailable(): ViewerAnswer {
  return { status: 503, body: { error: 'viewer-page-unavailable' } }
}
