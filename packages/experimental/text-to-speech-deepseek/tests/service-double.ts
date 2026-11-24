/** Loopback double of the DeepSeek speech synthesis API for provider specs. */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { onTestFinished } from 'vitest'

/** One request as the service received it. */
export interface RecordedRequest {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  /** Parsed JSON body. */
  readonly body: unknown
  /** Whether the client closed the connection before the reply ended. */
  closed: boolean
}

/** Response behavior for one request; the last reply repeats for later requests. */
export type Reply = (request: RecordedRequest, response: ServerResponse) => void

/**
 * Start a listener owned by the current test; it is closed at teardown, so its port is never released mid-test.
 * @param replies - responses in request order.
 * @returns the deployment base URL, the speech synthesis endpoint, and the recorded requests.
 */
export async function serviceDouble(...replies: Reply[]): Promise<{ baseURL: string; endpoint: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const recorded: RecordedRequest = { path: request.url ?? '', headers: request.headers, body, closed: false }
      response.on('close', () => { recorded.closed = !response.writableFinished })
      requests.push(recorded)
      replies[Math.min(requests.length, replies.length) - 1]!(recorded, response)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('service double: missing listener address')
  const baseURL = `http://127.0.0.1:${address.port}`
  return { baseURL, endpoint: `${baseURL}/v1/tools/tts`, requests }
}

/**
 * @param chunks - audio chunks written one by one.
 * @returns a successful reply streaming the chunks as raw PCM.
 */
export const audio = (...chunks: Uint8Array[]): Reply => (_request, response) => {
  response.writeHead(200, { 'content-type': 'audio/pcm' })
  for (const chunk of chunks) response.write(chunk)
  response.end()
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
 * @param status - HTTP status of the documented error.
 * @param message - the service's error message.
 * @returns an error reply in the service's error format.
 */
export const failed = (status: number, message: string): Reply =>
  json(status, { error: { message, type: 'invalid_request_error', param: null, code: 'invalid_request_error' } })

/**
 * @param status - HTTP status.
 * @param text - raw body.
 * @returns a reply sending the body as is, without a content type.
 */
export const raw = (status: number, text: string): Reply => (_request, response) => { response.writeHead(status).end(text) }

/**
 * @param chunk - audio sent before the connection breaks.
 * @returns a reply that starts the audio and then destroys the socket, as the service does when synthesis fails midway.
 */
export const cut = (chunk: Uint8Array): Reply => (_request, response) => {
  response.writeHead(200, { 'content-type': 'audio/pcm' })
  response.write(chunk, () => { response.socket?.destroy() })
}

/**
 * @param chunk - audio sent before the reply stalls.
 * @returns a reply that starts the audio and never finishes it.
 */
export const stalled = (chunk: Uint8Array): Reply => (_request, response) => {
  response.writeHead(200, { 'content-type': 'audio/pcm' })
  response.write(chunk)
}

/** A reply that never answers; the listener closes the socket at teardown. */
export const silent: Reply = () => {}
