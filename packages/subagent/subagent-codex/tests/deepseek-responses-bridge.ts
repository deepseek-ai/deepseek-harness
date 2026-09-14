import { createServer } from 'node:http'
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http'
import { completeResponsesEvents } from './responses-fixture.ts'

const OFFICIAL_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const MAX_REQUEST_BYTES = 1_048_576

/** One running test-only Responses-to-DeepSeek bridge. */
export interface DeepSeekResponsesBridge {
  readonly baseUrl: string
  readonly completedRequests: number
  close(): Promise<void>
}

function readRequest(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        request.destroy(new Error('DeepSeek bridge request exceeded its byte limit'))
      }
    })
    request.on('end', () => { resolve(body) })
    request.on('error', reject)
  })
}

function responseInputTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) return []
  return body.input.flatMap((item): string[] => {
    if (item === null || typeof item !== 'object') return []
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.flatMap((part): string[] => (
      part !== null
      && typeof part === 'object'
      && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    ))
  })
}

function taskText(body: Record<string, unknown>): string {
  const input = responseInputTexts(body).join('\n')
  if (input.trim().length > 0) return input
  return typeof body.instructions === 'string' ? body.instructions : ''
}

async function completeWithDeepSeek(
  authorization: string,
  task: string,
): Promise<string> {
  const response = await fetch(`${OFFICIAL_DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'system',
          content: 'Follow the user instruction and return only the requested nonce.',
        },
        { role: 'user', content: task },
      ],
      temperature: 0,
      max_tokens: 64,
      stream: false,
    }),
  })
  if (!response.ok) {
    void response.body?.cancel()
    throw new Error(`DeepSeek bridge upstream returned HTTP ${response.status}`)
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('DeepSeek bridge upstream returned no text')
  }
  return content
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

/**
 * Start the single-purpose loopback bridge used by the Codex credentialed e2e.
 * @param nonce - unique answer the incoming Responses task must request.
 * @returns loopback endpoint, completion count, and close operation.
 */
export async function startDeepSeekResponsesBridge(
  nonce: string,
): Promise<DeepSeekResponsesBridge> {
  let seenRequests = 0
  let completedRequests = 0
  const openResponses = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    openResponses.add(response)
    response.on('close', () => { openResponses.delete(response) })
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404)
        response.end()
        return
      }
      if (seenRequests !== 0) {
        response.writeHead(409)
        response.end()
        return
      }
      seenRequests += 1
      const authorization = request.headers.authorization
      if (
        typeof authorization !== 'string'
        || !authorization.startsWith('Bearer ')
        || authorization.length === 'Bearer '.length
      ) {
        throw new Error('Codex DeepSeek bridge received no bearer credential')
      }
      const body = JSON.parse(await readRequest(request)) as Record<string, unknown>
      const task = taskText(body)
      if (!task.includes(nonce)) {
        throw new Error('Codex DeepSeek bridge request omitted the expected nonce')
      }
      const text = await completeWithDeepSeek(authorization, task)
      completedRequests += 1
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': 'req_deepseek_e2e',
      })
      for (const event of completeResponsesEvents(text)) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' })
      }
      response.end(JSON.stringify({ error: { message: 'DeepSeek bridge request failed' } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('DeepSeek bridge did not acquire a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get completedRequests(): number { return completedRequests },
    async close(): Promise<void> {
      for (const response of openResponses) response.destroy()
      await closeServer(server)
    },
  }
}
