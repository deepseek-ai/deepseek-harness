/** Host Cordis plugin for the cross-realm Inspector Worker and full fetch capture. */

import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import serveStatic from 'serve-static'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-cmdline'
import open, { apps } from 'open'
import { resolveInspectorOptions, startInspector, type InspectorOptions } from './bridge/controller.ts'
import { createInspectorService } from '../shared/service.ts'
import { publishCordisTree } from './inspection/cordis.ts'
import { INSPECTOR_BOOTSTRAP_PATH, INSPECTOR_CLIENT_QUERY, readInspectorClientSelection } from '../shared/web.ts'
import { disposeInspectorResources } from '../shared/dispose.ts'

const DEVTOOLS_PATH = '/inspector/devtools'

export { resolveInspectorOptions, startInspector } from './bridge/controller.ts'
export type { InspectorEndpoint, InspectorHandle, InspectorOptions, InspectorSpec } from './bridge/controller.ts'
export type { CordisRuntimeTreeReader } from '../shared/cordis/reader.ts'
export type {
  CordisRuntimeConnection,
  CordisRuntimeContext,
  CordisRuntimeFiber,
  CordisRuntimeNode,
  CordisRuntimeRealm,
  CordisRuntimeSource,
  CordisRuntimeTree,
} from '../shared/cordis/model.ts'
export type { InspectorClientBootstrap } from '../shared/bridge/messages/control.ts'
export type { InspectorRecordInput, InspectorSourceDescriptor, InspectorSourceKind } from '../shared/bridge/messages/observation.ts'
export type { InspectorJsonObject, InspectorJsonPrimitive, InspectorJsonValue } from '../shared/json.ts'
export type {
  CordisContextTreeNode,
  CordisFiberTreeNode,
  CordisTreeNode,
  CordisTreeSnapshot,
} from '../shared/cordis/snapshot.ts'

/** Configuration consumed by the Host implementation after package-entry validation. */
export interface HostPluginConfig extends Omit<InspectorOptions, 'clientOrigins'> {
  /** Browser origins allowed to open the Client ingest WebSocket. */
  clientOrigins?: string[]
}

/** Start the Worker, expose `ctx.inspector`, and inject the matching Client bootstrap. */
export async function apply(ctx: Context, config: HostPluginConfig): Promise<void> {
  await ctx.effect(async () => {
    const spec = resolveInspectorOptions(config)
    const handle = await startInspector(spec)
    const disposers: Array<() => unknown> = []
    const dispose = () => disposeInspectorResources(disposers, () => handle.close(), 'experimental-inspector: disposal failed')
    try {
      disposers.push(publishCordisTree(ctx, handle.source, {
        maxNodes: spec.maxCordisNodes,
        maxBytes: spec.maxSourceFrameBytes - 4_096,
      }))
      disposers.push(ctx.provide('inspector', createInspectorService(handle.source)))
      disposers.push(ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
        table.push({ kind: 'global', name: '__DSH_INSPECTOR__', value: handle.endpoint.client })
      }))
      disposers.push(ctx.connection.fetch.register({
        path: INSPECTOR_BOOTSTRAP_PATH, methods: ['GET'], requestBody: 'buffered',
        fetch: () => Promise.resolve(Response.json(handle.endpoint.client, {
          headers: { 'cache-control': 'no-store' },
        })),
      }))
      const assets = serveStatic(fileURLToPath(new URL('./lib/devtools/',
        import.meta.resolve('@deepseek-ai/dsh-experimental-inspector/package.json'))), {
        index: false, redirect: false, fallthrough: true,
        setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff') },
      })
      disposers.push(ctx.webServer.register({
        kind: 'prefix', path: DEVTOOLS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' }).end()
            return
          }
          if (!ctx.connection.authorizeIndex(req, res)) return
          const url = new URL(req.url ?? '/', 'http://inspector.invalid')
          if (url.pathname === DEVTOOLS_PATH || url.pathname === `${DEVTOOLS_PATH}/`) {
            const location = `${url.pathname === DEVTOOLS_PATH ? 'devtools/' : ''}devtools_app.html${url.search}`
            res.writeHead(302, { location }).end()
            return
          }
          req.url = `${url.pathname.slice(DEVTOOLS_PATH.length)}${url.search}`
          assets(req, res, (error?: unknown) => {
            if (error !== undefined) {
              ctx.logger.warn('experimental-inspector: frontend asset request failed', error)
              if (res.headersSent) res.destroy()
              else res.writeHead(500).end()
            } else res.writeHead(404).end()
          })
        },
      }))
      const sockets = new Set<Duplex>()
      const track = (socket: Duplex): void => {
        sockets.add(socket)
        socket.once('close', () => { sockets.delete(socket) })
      }
      disposers.push(async () => {
        await Promise.all([...sockets].map(socket => new Promise<void>((resolve) => {
          socket.once('close', resolve)
          socket.destroy()
        })))
      })
      const target = new URL(handle.endpoint.webSocketDebuggerUrl)
      disposers.push(ctx.webServer.registerUpgrade({
        path: `${DEVTOOLS_PATH}/cdp`,
        handler: (req, socket, head) => {
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined) {
            const reason = rejection === 401 ? 'Unauthorized' : 'Forbidden'
            socket.end(`HTTP/1.1 ${rejection} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
            return
          }
          const endpoint = new URL(target)
          try {
            const selected = readInspectorClientSelection(new URL(req.url ?? '/', 'http://inspector.invalid'))
            if (selected !== undefined) endpoint.searchParams.set(INSPECTOR_CLIENT_QUERY, selected)
          } catch (error) {
            void error // Invalid selectors must not open an unfiltered connection.
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            return
          }
          const upstream = connect(Number(target.port), target.hostname)
          track(socket)
          track(upstream)
          upstream.once('connect', () => {
            upstream.write(`GET ${endpoint.pathname}${endpoint.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`)
            for (const [key, value] of Object.entries(req.headers)) {
              if (key.startsWith('sec-websocket-') && value !== undefined) {
                upstream.write(`${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
              }
            }
            upstream.write('\r\n')
            if (head.length > 0) upstream.write(head)
            socket.pipe(upstream).pipe(socket)
          })
          upstream.once('error', () => { socket.destroy() })
          socket.once('error', () => { upstream.destroy() })
          upstream.once('close', () => { socket.destroy() })
          socket.once('close', () => { upstream.destroy() })
        },
      }))
      // This readiness URL is emitted while the plugin tree is still loading, before a logger sink is guaranteed.
      console.log(`dsh inspector: ${handle.endpoint.devtoolsFrontendUrl}`)
      if (ctx.get('cmdlineArgs')?.get().includes('--inspect')) {
        await open(handle.endpoint.devtoolsFrontendUrl, { app: { name: apps.chrome }, wait: false }).catch((error: unknown) => {
          ctx.logger.error('experimental-inspector: Chrome could not open DevTools', error)
        })
      }
    } catch (error) {
      await dispose().catch((cleanupError: unknown) => {
        ctx.logger.error('experimental-inspector: initialization rollback failed', cleanupError)
      })
      throw error
    }
    return dispose
  }, 'experimental-inspector: Host Worker')
}
