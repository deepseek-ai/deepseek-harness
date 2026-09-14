import { createServer } from 'node:http'
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http'

/** One request observed by the package-private Responses fixture. */
interface RecordedResponsesRequest {
  readonly method: string | undefined
  readonly path: string | undefined
  readonly headers: IncomingHttpHeaders
  readonly body: Record<string, unknown>
}

/** Behavior consumed by one Responses request. */
export type ResponsesBehavior =
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'error'; readonly status: number; readonly message: string }
  | {
    readonly kind: 'functionCall'
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
  | {
    readonly kind: 'advertisedFunctionCall'
    readonly choices: readonly {
      readonly name: string
      readonly arguments: Record<string, unknown>
    }[]
  }
  | { readonly kind: 'hold' }

/** Running package-private Responses fixture. */
export interface ResponsesFixture {
  readonly baseUrl: string
  readonly requests: RecordedResponsesRequest[]
  readonly requestStarted: Promise<void>
  close(): Promise<void>
}

function responseObject(text: string): Record<string, unknown> {
  const message = {
    id: 'msg_fixture',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{
      type: 'output_text',
      annotations: [],
      logprobs: [],
      text,
    }],
  }
  return {
    id: 'resp_fixture',
    object: 'response',
    created_at: 1,
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: 'fixture-model',
    output: [message],
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: null,
    service_tier: 'default',
    store: false,
    temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 11,
    },
    user: null,
    metadata: {},
  }
}

/**
 * Build the minimal Responses SSE event sequence consumed by Codex 0.153.4.
 * @param text - exact assistant answer.
 * @returns ordered response lifecycle events.
 */
export function completeResponsesEvents(text: string): Record<string, unknown>[] {
  const completed = responseObject(text)
  const message = (completed.output as Record<string, unknown>[])[0]!
  const part = (message.content as Record<string, unknown>[])[0]!
  return [
    {
      type: 'response.created',
      response: { ...completed, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: '' },
    },
    {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: 'response.output_text.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: 'response.content_part.done',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: message,
    },
    { type: 'response.completed', response: completed },
  ]
}

function functionCallEvents(
  name: string,
  argumentsValue: Record<string, unknown>,
): Record<string, unknown>[] {
  const argumentsText = JSON.stringify(argumentsValue)
  const item = {
    id: 'fc_fixture',
    type: 'function_call',
    status: 'completed',
    name,
    arguments: argumentsText,
    call_id: 'call_fixture',
  }
  const completed = {
    ...responseObject(''),
    output: [item],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  }
  return [
    {
      type: 'response.created',
      response: { ...completed, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: 0,
      arguments: argumentsText,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item,
    },
    { type: 'response.completed', response: completed },
  ]
}

function readRequest(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => { resolve(body) })
    request.on('error', reject)
  })
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

function advertisedFunctionNames(body: Record<string, unknown>): Set<string> {
  if (!Array.isArray(body.tools)) return new Set()
  return new Set(body.tools.flatMap((tool): string[] => (
    tool !== null
    && typeof tool === 'object'
    && (tool as Record<string, unknown>).type === 'function'
    && typeof (tool as Record<string, unknown>).name === 'string'
      ? [(tool as Record<string, unknown>).name as string]
      : []
  )))
}

/**
 * Start a loopback-only Responses SSE fixture.
 * @param script - one behavior per expected Responses request.
 * @returns the running fixture and its observed requests.
 */
export async function startResponsesFixture(
  script: readonly ResponsesBehavior[],
): Promise<ResponsesFixture> {
  const behaviors = [...script]
  const requests: RecordedResponsesRequest[] = []
  const started = Promise.withResolvers<undefined>()
  const openResponses = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    openResponses.add(response)
    response.on('close', () => { openResponses.delete(response) })
    void readRequest(request).then((body) => {
      const parsedBody = JSON.parse(body) as Record<string, unknown>
      requests.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: parsedBody,
      })
      started.resolve(undefined)
      const behavior = behaviors.shift()
      if (behavior === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'fixture script exhausted' } }))
        return
      }
      const advertisedCall = behavior.kind === 'advertisedFunctionCall'
        ? behavior.choices.find(choice => advertisedFunctionNames(parsedBody).has(choice.name))
        : undefined
      if (behavior.kind === 'advertisedFunctionCall' && advertisedCall === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'none of the fixture function calls was advertised' } }))
        return
      }
      if (behavior.kind === 'error') {
        response.writeHead(behavior.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: behavior.message } }))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': 'req_fixture',
      })
      if (behavior.kind === 'hold') return
      let events: Record<string, unknown>[]
      if (behavior.kind === 'complete') {
        events = completeResponsesEvents(behavior.text)
      } else {
        const call = behavior.kind === 'functionCall'
          ? behavior
          : advertisedCall!
        events = functionCallEvents(call.name, call.arguments)
      }
      for (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    }).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
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
    throw new Error('responses fixture did not acquire a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    requestStarted: started.promise,
    async close(): Promise<void> {
      for (const response of openResponses) response.destroy()
      await closeServer(server)
    },
  }
}
