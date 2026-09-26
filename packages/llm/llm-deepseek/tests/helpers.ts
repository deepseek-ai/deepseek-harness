/** Deterministic Messages fixtures and loopback transport with explicit teardown. */
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { object } from '../src/replay.ts'
import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveAdapterOptions } from '../src/index.ts'
import { DeepSeekAdapter } from '../src/adapter.ts'
import type { Options as Config } from '../src/config.ts'
import type { DeepSeekAdapterOptions } from '../src/types.ts'
import { DeepSeekFileStore } from '../src/file-store.ts'

export const prepareExtensions = async () => ({ fields: {}, accept: async () => {} })

export const MODEL = 'deepseek-v4-flash'
export const user = (text = 'hello') => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
export const options = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'deepseek-official', model: MODEL, messages: [user()], ...overrides })
export const start = { type: 'message_start', message: { id: 'msg_1', model: MODEL, usage: { input_tokens: 12, output_tokens: 1 } } }
export const end = (reason = 'end_turn') => [
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]
export const textEvents = [start,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello 世界' } },
  { type: 'content_block_stop', index: 0 }, ...end()]
export const sse = (events: unknown[]) => events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
export async function* events(values: Record<string, unknown>[]) { yield* values }
export async function chunks(stream: AsyncIterable<StreamChunk>) {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
export async function assemble(stream: AsyncIterable<StreamChunk>, model = MODEL) {
  const assembler = new BlockAssembler()
  const output = await chunks(stream)
  for (const chunk of output) assembler.push(chunk)
  const message = createAssistantMessage({ content: assembler.blocks(), source: { provider: 'deepseek-official', model, ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState } } })
  return { output, message, assembler }
}
export function adapter(config: Config = {}, dependencies: Partial<DeepSeekAdapterOptions> = {}) {
  const files = new DeepSeekFileStore()
  return new DeepSeekAdapter({ options: () => resolveAdapterOptions(config), resolveAuth: () => Promise.resolve({ headers: { 'x-api-key': 'test-key' } }), resolveUserId: () => 'test-user' as AnonymousUserId, resolveAttachments: () => undefined, resolveImageAccess: () => undefined, resolveFiles: () => files, prepareExtensions, ...dependencies })
}
export async function server(reply: (response: ServerResponse, count: number) => void = response => response.end(sse(textEvents))) {
  const requests: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = []
  const http = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => response.destroy(error as Error))
  })
  async function handle(request: import('node:http').IncomingMessage, response: ServerResponse) {
    const parts: Buffer[] = []
    for await (const part of request as AsyncIterable<Buffer>) parts.push(part)
    requests.push({ path: request.url!, headers: request.headers, body: object(JSON.parse(Buffer.concat(parts).toString())) })
    response.setHeader('content-type', 'text/event-stream')
    reply(response, requests.length)
  }
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('missing loopback port')
  return {
    url: `http://127.0.0.1:${address.port}/anthropic`, requests,
    async close() {
      const closed = new Promise<void>((resolve, reject) => http.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
      http.closeAllConnections()
      await closed
    },
  }
}

/** Supply only the image projection operation; any unexpected storage work fails. */
export function requestImageStore(readImageRequest: AttachmentStore['readImageRequest']): AttachmentStore {
  class ProjectedAttachments extends AttachmentStore {
    get imageLimits(): never { throw new Error('unexpected image policy read') }
    validateImage(): never { throw new Error('unexpected image validation') }
    saveImage(): never { throw new Error('unexpected image save') }
    readImage(): never { throw new Error('unexpected original image read') }
    override readImageRequest = readImageRequest
  }
  return new ProjectedAttachments(new Context())
}

/** Import mapped source modules without claiming support for Node's HMR internals. */
export function sourceModuleLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}
