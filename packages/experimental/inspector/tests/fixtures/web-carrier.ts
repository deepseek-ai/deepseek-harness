/** Synthetic WebServer dispatch for requests with partial Node response fixtures. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { WebAdmission, WebAuthenticationRule, WebAuthRequest, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

function authorize(ctx: Context, req: IncomingMessage, auth: WebAuthenticationRule | undefined, transport: WebAuthRequest['transport']): WebAdmission {
  const request: WebAuthRequest = {
    headers: req.headers, method: req.method, url: new URL(req.url ?? '/', 'http://127.0.0.1'),
    transport, socket: req.socket,
  }
  const policy = typeof auth === 'function' ? auth(request) : auth ?? 'required'
  if (policy === 'deny') return { kind: 'deny', status: 403 }
  const admission: WebAdmission = ctx.bail('webserver/authorize', request, policy)
    ?? (policy === 'anonymous' ? { kind: 'allow' } : { kind: 'deny', status: 503 })
  if (admission.kind === 'allow') {
    if (policy === 'required' && admission.peer === undefined) return { kind: 'deny', status: 503 }
    if (admission.peer?.signal.aborted) return { kind: 'deny', status: 401 }
  }
  return admission
}

/**
 * Dispatch an HTTP fixture through the registered authorization listener.
 * @param ctx - Context owning the Connection authorization listener.
 * @param route - Matched route registration.
 * @param req - Incoming fixture request.
 * @param res - Response recorder.
 */
export async function dispatchHttp(ctx: Context, route: WebRoute, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const admission = authorize(ctx, req, route.auth, 'http')
  if (admission.kind === 'deny') res.writeHead(admission.status).end()
  else await route.handler(req, res, admission.peer)
}

/**
 * Dispatch an upgrade fixture through the registered authorization listener.
 * @param ctx - Context owning the Connection authorization listener.
 * @param route - Matched upgrade registration.
 * @param req - Incoming fixture request.
 * @param socket - Browser-side transport.
 * @param head - Early upgrade bytes.
 */
export async function dispatchUpgrade(
  ctx: Context, route: WebUpgradeRoute, req: IncomingMessage, socket: Duplex, head: Buffer,
): Promise<void> {
  const admission = authorize(ctx, req, route.auth, 'upgrade')
  if (admission.kind === 'deny') {
    const reason = { 401: 'Unauthorized', 403: 'Forbidden', 503: 'Service Unavailable' }[admission.status]
    socket.end(`HTTP/1.1 ${String(admission.status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } else await route.handler(req, socket, head, admission.peer)
}
