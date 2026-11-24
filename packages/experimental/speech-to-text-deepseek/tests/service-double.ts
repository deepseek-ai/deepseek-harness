/** Loopback double of the DeepSeek speech recognition API and canonical WAV recordings for provider specs. */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { onTestFinished } from 'vitest'

/** One request as the service received it. */
export interface RecordedRequest {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  /** Bytes of the multipart `file` field, or of the whole body for another content type. */
  readonly file: Uint8Array
  readonly filename: string | undefined
  readonly fileType: string | undefined
}

/** Response behavior for one request; the last reply repeats for later requests. */
export type Reply = (request: RecordedRequest, response: ServerResponse) => void

/**
 * Start a listener owned by the current test; it is closed at teardown, so its port is never released mid-test.
 * @param replies - responses in request order.
 * @returns the deployment base URL, the speech recognition endpoint, and the recorded requests.
 */
export async function serviceDouble(...replies: Reply[]): Promise<{ baseURL: string; endpoint: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks), type = request.headers['content-type'] ?? ''
        let file = new Uint8Array(body), filename: string | undefined, fileType: string | undefined
        if (type.startsWith('multipart/form-data')) {
          const value = (await new Response(body, { headers: { 'content-type': type } }).formData()).get('file')
          if (value instanceof File) { file = new Uint8Array(await value.arrayBuffer()); filename = value.name; fileType = value.type }
        }
        const recorded = { path: request.url ?? '', headers: request.headers, file, filename, fileType }
        requests.push(recorded)
        replies[Math.min(requests.length, replies.length) - 1]!(recorded, response)
      })()
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('service double: missing listener address')
  const baseURL = `http://127.0.0.1:${address.port}`
  return { baseURL, endpoint: `${baseURL}/v1/tools/asr`, requests }
}

/**
 * @param status - HTTP status.
 * @param body - JSON body.
 * @returns a reply sending the JSON body.
 */
export const json = (status: number, body: unknown): Reply => (_request, response) => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/**
 * @param text - recognized text.
 * @param durationMs - audio duration the service reports.
 * @returns a successful recognition reply.
 */
export const recognized = (text: string, durationMs?: number): Reply =>
  json(200, { request_id: 'req-1', text, ...durationMs === undefined ? {} : { duration_ms: durationMs } })

/**
 * @param status - HTTP status of the documented error.
 * @param message - the service's error message.
 * @returns an error reply in the service's error format.
 */
export const failed = (status: number, message: string): Reply =>
  json(status, { error: { message, type: 'invalid_request_error', param: null, code: 'invalid_request_error' } })

/**
 * @param status - HTTP status.
 * @param text - raw body.
 * @returns a reply sending the body as is.
 */
export const raw = (status: number, text: string): Reply => (_request, response) => { response.writeHead(status).end(text) }

/** A reply that closes the connection without answering, as the service does when it rejects an upload early. */
export const dropped: Reply = (_request, response) => { response.socket?.destroy() }

/** A reply that never answers; the listener closes the socket at teardown. */
export const silent: Reply = () => {}

/**
 * Build a canonical 16 kHz mono PCM16 WAV recording.
 * @param pcmBytes - sample bytes after the 44-byte header.
 * @returns WAV bytes whose samples are a repeating ramp.
 */
export function wave(pcmBytes: number): Uint8Array {
  const data = Buffer.alloc(44 + pcmBytes)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(pcmBytes, 40)
  for (let index = 0; index < pcmBytes; index++) data[44 + index] = index % 251
  return new Uint8Array(data)
}
