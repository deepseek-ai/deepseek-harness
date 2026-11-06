/** Loopback double of the One-Shot endpoint and canonical WAV recordings for provider specs. */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { onTestFinished } from 'vitest'

/** One request as the service received it. */
export interface RecordedRequest {
  readonly headers: IncomingHttpHeaders
  readonly fields: ReadonlyMap<string, string>
  readonly file: Uint8Array
}

/** Response behavior for one request; the last reply repeats for later requests. */
export type Reply = (request: RecordedRequest, response: ServerResponse) => void

/**
 * Start a listener owned by the current test.
 * @param replies - responses in request order.
 * @returns the endpoint URL and the recorded requests.
 */
export async function serviceDouble(...replies: Reply[]): Promise<{ endpoint: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks), type = request.headers['content-type'] ?? ''
        const fields = new Map<string, string>()
        let file = new Uint8Array(body)
        if (type.startsWith('multipart/form-data')) {
          for (const [name, value] of await new Response(body, { headers: { 'content-type': type } }).formData()) {
            if (typeof value === 'string') fields.set(name, value)
            else file = new Uint8Array(await value.arrayBuffer())
          }
        }
        const recorded = { headers: request.headers, fields, file }
        requests.push(recorded)
        replies[Math.min(requests.length, replies.length) - 1]!(recorded, response)
      })()
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('service double: missing listener address')
  return { endpoint: `http://127.0.0.1:${address.port}/api/v0/asr/transcribe`, requests }
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
 * @returns a successful recognition reply.
 */
export const recognized = (text: string): Reply => json(200, { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { text, audio_id: 'echo' } } })

/**
 * @param code - `biz_data.code` of the failed recognition.
 * @returns a classified recognition failure reply.
 */
export const refused = (code: number): Reply => json(200, { code: 0, msg: '', data: { biz_code: 2, biz_msg: 'asr failed', biz_data: { code, toast: 'x', audio_id: 'echo' } } })

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
