/** Anonymous one-use credential exchange; application RPC remains authenticated. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'

interface LoginRoute {
  readonly root: string
  readonly available: boolean
  readonly consume: (token: string) => boolean
  readonly issueCookie: (request: ConnectionTrustRequest) => string | undefined
  readonly signal: AbortSignal
}

const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

/**
 * Identify the explicit QR mode without accepting mixed Token credentials.
 * @param url - application root URL whose query selects the login mode.
 * @returns whether exactly one login parameter selects QR exchange without a Token query.
 */
export function isQrLogin(url: URL): boolean {
  const modes = url.searchParams.getAll('login')
  return modes.length === 1 && modes[0] === 'qr' && !url.searchParams.has('token')
}

/**
 * Redeem a raw base64url credential after anonymous source admission.
 * The POST is bound to the advertised authority; only a successful one-use
 * exchange receives a Remote browser cookie.
 * @param route - owning service's current availability and credential consumer.
 * @param request - incoming request with an at-most-43-byte credential body.
 * @param response - HTTP response owned through completion.
 */
export async function handleLogin(route: LoginRoute, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const root = new URL(route.root)
  if (new URL(`${root.protocol}//${request.headers.host}`).host !== root.host) {
    response.writeHead(403, HEADERS)
    response.end()
    return
  }
  if (!route.available) {
    response.writeHead(403, HEADERS)
    response.end()
    return
  }
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/plain') {
    response.writeHead(400, HEADERS)
    response.end()
    return
  }
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > 43) {
    response.writeHead(413, { ...HEADERS, connection: 'close' })
    response.end()
    request.destroy()
    return
  }
  const chunks: Buffer[] = []
  let received = 0
  try {
    for await (const chunk of request) {
      const bytes = chunk as Buffer
      received += bytes.byteLength
      if (received > 43) {
        response.writeHead(413, { ...HEADERS, connection: 'close' })
        response.end()
        request.destroy()
        return
      }
      chunks.push(bytes)
    }
  } catch (_readFailure) {
    // A failed body read cannot consume an invitation or issue a browser credential.
    if (!response.destroyed && !response.headersSent) {
      response.writeHead(410, HEADERS)
      response.end()
    }
    return
  }
  if (route.signal.aborted || response.destroyed) return
  const token = Buffer.concat(chunks).toString('utf8')
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    response.writeHead(400, HEADERS)
    response.end()
    return
  }
  if (!route.consume(token)) {
    response.writeHead(410, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ code: 'invalid-or-expired' }))
    return
  }
  const cookie = route.issueCookie(request)
  if (cookie === undefined) {
    response.writeHead(403, HEADERS)
    response.end()
    return
  }
  // An HTTPS public URL may terminate TLS at a proxy before the HTTP listener.
  const sessionCookie = root.protocol === 'https:' && !cookie.includes('; Secure') ? `${cookie}; Secure` : cookie
  response.writeHead(204, { ...HEADERS, 'set-cookie': sessionCookie })
  response.end()
}
