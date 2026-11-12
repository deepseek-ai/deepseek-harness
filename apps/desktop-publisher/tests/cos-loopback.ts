/** Loopback HTTP capture for tests that exercise real COS SDK request serialization. */

import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type COS from 'cos-nodejs-sdk-v5'

/** One request the SDK actually sent, with bytes read from the wire. */
export interface CosLoopbackRequest {
  readonly method: string
  /** Request path including the query string, as sent to the real endpoint. */
  readonly path: string
  /** Lowercased request headers exactly as the SDK wrote them. */
  readonly headers: Record<string, string | string[] | undefined>
  /** Exact body bytes received. */
  readonly body: Buffer
  /** Signed URL the SDK built before the test redirected it to this server. */
  readonly signedUrl: string | undefined
}

/** Owns one request's reply; use {@link answer} for a complete response. */
export type CosLoopbackResponder = (request: CosLoopbackRequest, response: ServerResponse) => void | Promise<void>

/** One isolated HTTP origin that captures SDK requests instead of reaching COS. */
export interface CosLoopback {
  readonly requests: CosLoopbackRequest[]
  /** Redirect every SDK request to this server while keeping the signed headers intact. */
  redirect(cos: COS): void
  /** Close the server; rejects with the first responder failure so no reply error stays silent. */
  close(): Promise<void>
}

/**
 * Write a complete response and close the connection so the client cannot reuse its socket.
 * @param socket Response object owned by the responder.
 * @param status HTTP status code.
 * @param body Complete response body.
 * @param headers Additional response headers.
 */
export function answer(socket: ServerResponse, status = 200, body: string | Buffer = '',
  headers: Record<string, string> = {}): void {
  socket.writeHead(status, { connection: 'close', ...headers })
  socket.end(body)
}

/**
 * Build a COS error body the SDK maps to its error code.
 * @param code COS error code, such as `NoSuchKey` or `InternalError`.
 * @param message Server message; tests use it to prove diagnostics stay out of retained records.
 * @returns XML error document.
 */
export function cosError(code: string, message = 'fixture'): string {
  return `<Error><Code>${code}</Code><Message>${message}</Message></Error>`
}

/**
 * Start a loopback server that records each request before the responder answers it.
 * @param responder Reply for each captured request; the default is an empty 200.
 * @returns Recorded requests, the SDK redirect, and an idempotent close.
 */
export async function startCosLoopback(
  responder: CosLoopbackResponder = (_request, response) => { answer(response) },
): Promise<CosLoopback> {
  const requests: CosLoopbackRequest[] = []
  const signedUrls: string[] = []
  const failures: unknown[] = []
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const request: CosLoopbackRequest = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks),
        signedUrl: signedUrls[requests.length],
      }
      requests.push(request)
      void Promise.resolve(responder(request, response)).catch((error: unknown) => {
        failures.push(error)
        response.destroy()
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const { port } = server.address() as AddressInfo
  let closed = false
  return {
    requests,
    redirect(cos) {
      cos.on('before-send', (options: { url: string }) => {
        signedUrls.push(options.url)
        const parsed = new URL(options.url)
        options.url = `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`
      })
    },
    async close() {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
      if (failures.length > 0) throw failures[0]
    },
  }
}
