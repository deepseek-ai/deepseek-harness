/** Anonymous pairing routes admitted by the WebServer's source policy. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import { normalizeBindAddress } from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import type { PairingRequestId } from './pairing-types.ts'
import type { PairingRequests } from './pairing-requests.ts'

const MAX_BODY_BYTES = 1024
const ticketInput = z.object({ id: z.uuid(), secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict()
type Operation = 'request' | 'status' | 'cancel'
type BodyResult = { readonly status: 'body'; readonly text: string } | { readonly status: 'invalid' | 'too-large' | 'unavailable' }

/**
 * Register public POST routes and join in-flight bodies during plugin disposal.
 * Bodies above 1KiB receive 413 and close the connection without waiting for the remaining bytes.
 * @param ctx - plugin scope carrying the HTTP listener.
 * @param requests - this activation's private request pool.
 * @param lifetime - plugin lifetime, aborted before retained requests are cleared.
 * @param issueCookie - Remote-owned credential issuer, available after initialization.
 * @returns disposer that stops and drains requests before withdrawing the routes.
 */
export function registerPairingRoutes(
  ctx: Context, requests: PairingRequests, lifetime: AbortController,
  issueCookie: (request: ConnectionTrustRequest) => string | undefined,
): () => Promise<void> {
  const pending = new Set<Promise<void>>()
  return ctx.effect(function* () {
    for (const operation of ['request', 'status', 'cancel'] as const) {
      yield ctx.webServer.register({
        kind: 'exact', path: `/pairing/${operation}`, auth: 'anonymous',
        async handler(request, response) {
          const task = handleRequest(ctx, requests, lifetime.signal, issueCookie, operation, request, response)
          pending.add(task)
          try { await task } finally { pending.delete(task) }
        },
      })
    }
    yield async () => {
      lifetime.abort()
      requests.clear()
      await Promise.allSettled([...pending])
    }
  })
}

async function handleRequest(
  ctx: Context, requests: PairingRequests, lifetime: AbortSignal,
  issueCookie: (request: ConnectionTrustRequest) => string | undefined,
  operation: Operation, request: IncomingMessage, response: ServerResponse,
): Promise<void> {
  if (lifetime.aborted) {
    send(response, 503, { status: 'unavailable' })
    return
  }
  if (request.method !== 'POST') {
    send(response, 405, { status: 'invalid' }, { allow: 'POST' })
    return
  }
  const host = request.headers.host as string
  // WebServer admission validated the Host; forwarded headers do not select the scheme.
  const authority = new URL(`${ctx.webServer.protocol}//${host}`).origin
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    send(response, 400, { status: 'invalid' })
    return
  }
  const disconnected = new AbortController()
  const remoteAddress = request.socket.remoteAddress
  const onClose = (): void => { disconnected.abort() }
  response.on('close', onClose)
  try {
    const body = await readBody(request, AbortSignal.any([lifetime, disconnected.signal]))
    if (response.destroyed) return
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- disposal can abort while the body is awaited
    if (lifetime.aborted || body.status === 'unavailable') {
      send(response, 503, { status: 'unavailable' })
      return
    }
    if (body.status === 'too-large') {
      send(response, 413, { status: 'invalid' }, { connection: 'close' })
      request.destroy()
      return
    }
    if (body.status !== 'body') {
      send(response, 400, { status: 'invalid' })
      return
    }
    let value: unknown
    try { value = JSON.parse(body.text) } catch (_invalidJson) {
      // A malformed wire body creates no request and cannot change an existing one.
      send(response, 400, { status: 'invalid' })
      return
    }
    const input = ticketInput.safeParse(value)
    if (!input.success) {
      send(response, 400, { status: 'invalid' })
      return
    }
    if (operation === 'request') {
      const ticket = requests.create(authority, remoteAddress === undefined ? null : normalizeBindAddress(remoteAddress), {
        id: input.data.id as PairingRequestId, secret: input.data.secret,
      })
      if (ticket === undefined) send(response, 429, { status: 'busy' })
      else send(response, 200, ticket)
      return
    }
    const result = requests.poll(input.data.id as PairingRequestId, input.data.secret, authority,
      operation === 'cancel', () => {
        const cookie = issueCookie(request)
        return cookie !== undefined && new URL(ctx.webApp.getAdvertisedUrl()).protocol === 'https:' && !cookie.includes('; Secure')
          ? `${cookie}; Secure` : cookie
      })
    if (result.status === 'completed') {
      send(response, 200, { status: 'completed' }, { 'set-cookie': result.cookie })
      return
    }
    send(response, result.status === 'slow-down' ? 429 : result.status === 'unavailable' ? 503 : 200, result)
  } catch (error) {
    ctx.logger.warn('Pairing login could not complete; the applicant can retry the same request', error)
    send(response, 503, { status: 'unavailable' })
  } finally {
    response.off('close', onClose)
  }
}

function send(response: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  response.end(JSON.stringify(body))
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (result: BodyResult): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      signal.removeEventListener('abort', onAbort)
      if (result.status === 'too-large') request.pause()
      else request.resume()
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) finish({ status: 'too-large' })
      else chunks.push(chunk)
    }
    const onEnd = (): void => { finish({ status: 'body', text: Buffer.concat(chunks, size).toString('utf8') }) }
    const onError = (): void => { finish({ status: 'invalid' }) }
    const onAbort = (): void => { finish({ status: 'unavailable' }) }
    const onClose = (): void => { request.off('error', onError) }
    request.on('data', onData)
    request.once('end', onEnd)
    // A disconnected request may emit its error after the response has closed and settled the body.
    request.once('error', onError)
    request.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    const declaredLength = request.headers['content-length']
    if (declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES) finish({ status: 'too-large' })
  })
}
