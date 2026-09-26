/** Authenticated loopback transport for one serial native recognizer. */
import { createServer, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { SpeechInputError } from './input.ts'

/**
 * Bind an ephemeral loopback listener; model loading completes before readiness is published.
 * @param token - private per-process authentication secret.
 * @param maxAudioBytes - maximum retained request bytes.
 * @param transcribe - synchronous inference owned by this process.
 * @returns the listening server and its dynamically assigned port.
 */
export async function startRecognitionServer(token: string, maxAudioBytes: number,
  transcribe: (audio: Uint8Array, language: string) => Transcript): Promise<{ server: Server; port: number }> {
  const expected = Buffer.from(`Bearer ${token}`)
  const server = createServer((request, response) => {
    const reply = (status: number, value: object): void => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume(); reply(401, { error: 'Unauthorized' }); return
    }
    const url = new URL(request.url as string, 'http://localhost')
    if (request.method !== 'POST' || url.pathname !== '/transcribe') {
      request.resume(); reply(404, { error: 'Unknown endpoint' }); return
    }
    const length = Number(request.headers['content-length'])
    if (!Number.isSafeInteger(length) || length < 46 || length > maxAudioBytes) {
      request.resume(); reply(413, { error: 'Invalid speech audio size', code: 'invalid-input' }); return
    }
    void (async () => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const bytes = chunk as Buffer
          chunks.push(bytes)
        }
        reply(200, transcribe(Buffer.concat(chunks), url.searchParams.get('language') ?? 'auto'))
      } catch (error) {
        reply(error instanceof SpeechInputError ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
          ...error instanceof SpeechInputError ? { code: 'invalid-input' } : {},
        })
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address() as { port: number }
  return { server, port: address.port }
}
