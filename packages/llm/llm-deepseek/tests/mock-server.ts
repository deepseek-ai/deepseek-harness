import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted behavior for the next request the mock server receives. */
export type Behavior =
  | { kind: 'sse'; events: string[]; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: 'close-early'; events: string[] }

export interface MockServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  /** Parsed Files API operations, excluded from model request ordering. */
  fileRequests: Array<{ method: string; path: string; filename?: string; bytes?: number }>
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text generation, reused by request-shape assertions. */
export const textEvents = [
  { type: 'message_start', message: { id: 'msg_1', model: 'deepseek-v4-flash', usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => JSON.stringify(event))

/** Local Messages stand-in: replays scripted behaviors per request. */
export async function mockServer(script: Behavior[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const fileRequests: MockServer['fileRequests'] = []
  const files = new Map<string, { id: string; type: 'file'; size_bytes: number; created_at: string; filename: string; mime_type: string }>()
  let nextFile = 1
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const body = Buffer.concat(chunks)
        if (url.pathname === '/v1/files' && request.method === 'POST') {
          const headers = new Headers()
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          const form = await new Request('http://localhost/v1/files', {
            method: 'POST',
            headers,
            body,
          }).formData()
          const blob = form.get('file')
          if (!(blob instanceof Blob)) throw new Error('mock upload omitted file')
          const name = 'name' in blob && typeof blob.name === 'string' ? blob.name : 'uploaded_file'
          const id = `file-api-${nextFile}`
          const createdAt = new Date().toISOString()
          nextFile += 1
          const file = {
            id,
            type: 'file' as const,
            size_bytes: blob.size,
            created_at: createdAt,
            filename: name,
            mime_type: blob.type,
          }
          files.set(id, file)
          fileRequests.push({ method: 'POST', path: url.pathname, filename: name, bytes: blob.size })
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(file))
          return
        }
        if (url.pathname === '/v1/files' && request.method === 'GET') {
          fileRequests.push({ method: 'GET', path: `${url.pathname}${url.search}` })
          const data = [...files.values()]
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            data,
            first_id: data[0]?.id,
            last_id: data.at(-1)?.id,
            has_more: false,
          }))
          return
        }
        if (url.pathname.startsWith('/v1/files/') && request.method === 'DELETE') {
          const id = decodeURIComponent(url.pathname.slice('/v1/files/'.length))
          files.delete(id)
          fileRequests.push({ method: 'DELETE', path: url.pathname })
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            id, type: 'file_deleted',
          }))
          return
        }
        if (url.pathname.startsWith('/v1/files/') && request.method === 'GET') {
          const id = decodeURIComponent(url.pathname.slice('/v1/files/'.length))
          fileRequests.push({ method: 'GET', path: url.pathname })
          const file = files.get(id)
          if (file === undefined) {
            response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
              error: { message: 'file not found', code: 'file_not_found' },
            }))
          } else {
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(file))
          }
          return
        }

        requests.push(JSON.parse(body.toString('utf8')))
        headers.push(request.headers)
        const behavior = script.shift()
        if (!behavior) {
          response.writeHead(500).end('mock script exhausted')
          return
        }
        if (behavior.kind === 'http-error') {
          response.writeHead(behavior.status, {
            'content-type': behavior.contentType ?? 'application/json',
            ...behavior.headers,
          })
          response.end(behavior.body)
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const write = (index: number): void => {
          if (index >= behavior.events.length) {
            if (behavior.kind === 'sse') response.end()
            else response.destroy() // close-early: drop the socket mid-stream
            return
          }
          response.write(`data: ${behavior.events[index]}\n\n`)
          setTimeout(() => { write(index + 1) }, behavior.kind === 'sse' ? behavior.delayMs ?? 0 : 5)
        }
        write(0)
      })().catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
      })
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    fileRequests,
    script,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}
