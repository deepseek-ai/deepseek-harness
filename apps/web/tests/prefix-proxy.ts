/**
 * Test-only HTTP plumbing for the Web browser scaffold beside it
 * (`./scaffold.ts`). The proxy owns one browser-facing mount: it preserves the
 * external Host, strips the prefix, removes hop-by-hop headers, forwards WebSocket upgrades, and rewrites the
 * backend's `Path=/` cookies to the mount. TLS terminates at the real
 * deployment's proxy; this fixture stays plain HTTP.
 */
import {
  createServer as createHttpServer, request as httpRequest,
  type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse,
} from 'node:http'
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net'

/** Headers that describe one hop and must not reach the origin. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']

/** Options for {@link startPrefixProxy}. */
export interface PrefixProxyOptions {
  /** Browser-facing mount; must start with `/` and end with `/`. */
  prefix: string
}

/** One running prefix proxy; its owner disposes it with {@link PrefixProxy.close}. */
export interface PrefixProxy {
  /** Loopback port assigned by the operating system. */
  readonly port: number
  /** Point the proxy at the backend listener; requests before this answer `502`. */
  setTarget(port: number): void
  /** Stop accepting, destroy live sockets, and resolve once every listener and socket closed. */
  close(): Promise<void>
}

/**
 * Start the proxy on an operating-system-assigned loopback port.
 * @param options - browser-facing mount prefix.
 * @returns the running proxy; the caller owns registration and disposal.
 */
export async function startPrefixProxy(options: PrefixProxyOptions): Promise<PrefixProxy> {
  const { prefix } = options
  const server = createHttpServer()
  let targetPort: number | undefined
  let closing: Promise<void> | undefined
  const sockets = new Set<Socket>()
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    if (closing !== undefined) socket.destroy()
  }
  const mountPath = (raw: string): string | undefined => {
    const url = new URL(raw, 'http://dsh.invalid')
    if (!url.pathname.startsWith(prefix)) return undefined
    return `/${url.pathname.slice(prefix.length)}${url.search}`
  }
  const forward = (headers: IncomingMessage['headers']): OutgoingHttpHeaders => {
    const copy = { ...headers }
    for (const name of HOP_BY_HOP) Reflect.deleteProperty(copy, name)
    return copy
  }
  const rewriteCookies = (headers: IncomingMessage['headers']): OutgoingHttpHeaders => {
    const copy = forward(headers)
    const setCookie = copy['set-cookie']
    if (setCookie === undefined) return copy
    const values = Array.isArray(setCookie) ? setCookie : [setCookie]
    copy['set-cookie'] = values.map(value => value.replace(/(^|;\s*)Path=\/(?=;|$)/iu, `$1Path=${prefix}`))
    return copy
  }
  server.on('request', (requestMessage: IncomingMessage, response: ServerResponse) => {
    if (closing !== undefined) { response.destroy(); return }
    const routed = mountPath(requestMessage.url ?? '/')
    if (routed === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    if (targetPort === undefined) {
      response.writeHead(502)
      response.end()
      return
    }
    const upstream = httpRequest({
      host: '127.0.0.1', port: targetPort, method: requestMessage.method, path: routed,
      headers: forward(requestMessage.headers), agent: false,
    }, (result) => {
      response.writeHead(result.statusCode as number, rewriteCookies(result.headers))
      result.pipe(response)
    })
    upstream.on('socket', track)
    upstream.once('error', (error) => { response.destroy(error) })
    response.once('close', () => { upstream.destroy() })
    requestMessage.pipe(upstream)
  })
  // An upgrade speaks its own hop-by-hop framing, so it cannot ride the
  // request handler: replay the request line and raw headers at the backend,
  // then pipe both directions raw until either side closes.
  server.on('upgrade', (requestMessage, socket, head) => {
    const routed = mountPath(requestMessage.url ?? '/')
    if (closing !== undefined || targetPort === undefined || routed === undefined) {
      socket.destroy()
      return
    }
    const upstream = netConnect(targetPort, '127.0.0.1')
    track(upstream)
    upstream.once('connect', () => {
      upstream.write(`${requestMessage.method} ${routed} HTTP/1.1\r\n`)
      for (let index = 0; index < requestMessage.rawHeaders.length; index += 2) {
        upstream.write(`${requestMessage.rawHeaders[index]}: ${requestMessage.rawHeaders[index + 1]}\r\n`)
      }
      upstream.write('\r\n')
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.once('error', () => { socket.destroy() })
    socket.once('error', () => { upstream.destroy() })
    upstream.once('close', () => { socket.destroy() })
    socket.once('close', () => { upstream.destroy() })
  })
  server.on('connection', track)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    port,
    setTarget(port: number) { targetPort = port },
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
        const drained = [...sockets].map(socket => new Promise<void>((resolve) => {
          socket.once('close', () => { resolve() })
          socket.destroy()
        }))
        await Promise.all([stopped, ...drained])
      })()
      return closing
    },
  }
}
