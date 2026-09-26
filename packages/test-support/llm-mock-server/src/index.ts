/**
 * Scriptable Messages HTTP/SSE server for transport, protocol, and
 * semantic-empty LLM recovery tests. Each accepted Messages request
 * consumes one behavior; the server never retries or interprets harness policy.
 *
 * @module @deepseek-ai/dsh-llm-mock-server
 */

import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { isIP, type AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/** Request-scoped behaviors accepted by {@link startMockLlmServer}. */
export const MOCK_LLM_BEHAVIORS = [
  'connection_reset',
  'stream_disconnect',
  'empty',
  'empty_body',
  'stream_eof',
  'partial_eof',
  'partial_disconnect',
  'stall',
  'malformed_json',
  'malformed_event',
  'wrong_content_type',
  'rate_limit',
  'server_error',
  'service_unavailable',
  'auth_error',
  'invalid_request',
  'context_overflow',
  'quota_exceeded',
  'success',
  'reasoning_success',
  'tool_call_success',
  'max_tokens',
  'slow_success',
  'random',
] as const

/** One scripted mock behavior name; `random` selects a concrete behavior per request. */
export type MockLlmBehavior = typeof MOCK_LLM_BEHAVIORS[number]

/** One concrete request behavior after resolving a `random` script entry. */
export type ConcreteMockLlmBehavior = Exclude<MockLlmBehavior, 'random'>

/** Relative non-negative weights for random request behavior selection. */
export type MockLlmRandomWeights = Partial<Record<ConcreteMockLlmBehavior, number>>

/**
 * Default stress profile for `random`. Weights are configurable test pressure,
 * not a claim about production incident frequency.
 */
export const DEFAULT_MOCK_LLM_RANDOM_WEIGHTS: Readonly<MockLlmRandomWeights> = Object.freeze({
  success: 48,
  slow_success: 10,
  max_tokens: 2,
  connection_reset: 5,
  stream_disconnect: 5,
  partial_disconnect: 10,
  empty: 5,
  stall: 2,
  rate_limit: 5,
  server_error: 4,
  service_unavailable: 2,
  partial_eof: 1,
  malformed_json: 1,
})

/** Largest millisecond delay accepted by Node timers without truncation. */
export const MAX_MOCK_LLM_TIMER_DELAY_MS = 2_147_483_647

/** How one accepted request ended at the mock boundary. */
export type MockLlmRequestOutcome = 'completed' | 'reset' | 'stalled' | 'client_closed' | 'server_error'

/** Immutable telemetry emitted when a request starts or reaches an outcome. */
export type MockLlmServerEvent =
  | {
    readonly type: 'request'
    readonly attempt: number
    readonly scriptBehavior: MockLlmBehavior | 'script_exhausted'
    readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted'
    readonly path: string
  }
  | {
    readonly type: 'result'
    readonly attempt: number
    readonly scriptBehavior: MockLlmBehavior | 'script_exhausted'
    readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted'
    readonly outcome: MockLlmRequestOutcome
    readonly chunksSent: number
  }

/** Captured wire request and its final server-side outcome. */
export interface MockLlmRequestRecord {
  /** One-based accepted Messages request number. */
  readonly attempt: number
  /** Script entry consumed for this request before random resolution. */
  readonly scriptBehavior: MockLlmBehavior | 'script_exhausted'
  /** Concrete behavior selected for this request, or exhaustion after the configured script. */
  readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted'
  /** Original request path, including a `/v1` prefix when the client supplied one. */
  readonly path: string
  /** Detached request headers. */
  readonly headers: Readonly<IncomingHttpHeaders>
  /** Parsed JSON request body. */
  readonly body: unknown
  /** Number of SSE `data:` events handed to Node before the outcome. */
  chunksSent: number
  /** Final server-side outcome; absent while a stalled request remains open. */
  outcome?: MockLlmRequestOutcome
}

/** Configuration for one mock server instance. */
export interface MockLlmServerOptions {
  /** Loopback host by default. */
  readonly host?: string
  /** TCP port; zero requests an OS-assigned port. */
  readonly port?: number
  /** Optional exact API key; omission accepts any x-api-key header. */
  readonly apiKey?: string
  /** Ordered request behaviors; exhaustion fails loud unless `repeatLast` is true. */
  readonly sequence: readonly MockLlmBehavior[]
  /** Reuse the final behavior after the sequence is consumed. */
  readonly repeatLast?: boolean
  /** Optional deterministic unsigned 32-bit seed; omission generates and exposes one. */
  readonly randomSeed?: number
  /** Relative weights used whenever a script entry is `random`. */
  readonly randomWeights?: Readonly<MockLlmRandomWeights>
  /** Complete text returned by success-shaped behaviors. */
  readonly successText?: string
  /** Text emitted before partial EOF/reset behaviors terminate. */
  readonly partialText?: string
  /** Reasoning text emitted by `reasoning_success`. */
  readonly reasoningText?: string
  /** Unicode code-point count per text or reasoning SSE delta. */
  readonly chunkSize?: number
  /** Inter-chunk delay for `slow_success`, in milliseconds. */
  readonly chunkDelayMs?: number
  /** Delay after headers/deltas before a forced disconnect, in milliseconds. */
  readonly disconnectDelayMs?: number
  /** Provider retry delay; the wire `Retry-After` value rounds up to whole seconds. */
  readonly retryAfterMs?: number
  /** Optional provider request id returned on HTTP failures. */
  readonly requestId?: string
  /** Tool name emitted by `tool_call_success`. */
  readonly toolName?: string
  /** Raw JSON arguments emitted by `tool_call_success`. */
  readonly toolArguments?: string
  /** Optional observer for JSONL CLI telemetry; observer failures never affect wire behavior. */
  readonly onEvent?: (event: MockLlmServerEvent) => void
}

/** Running mock server and captured request state. */
export interface MockLlmServer {
  /** Base URL without `/v1`; the endpoint is `/v1/messages`. */
  readonly baseURL: string
  /** Actual bound port, including an OS-assigned value. */
  readonly port: number
  /** Seed used for random behavior selection, including the generated default. */
  readonly randomSeed: number
  /** Live request records in arrival order. */
  readonly requests: readonly MockLlmRequestRecord[]
  /** Stop accepting requests and force-close stalled/streaming connections; idempotent. */
  close(): Promise<void>
}

interface ResolvedOptions {
  readonly host: string
  readonly port: number
  readonly apiKey?: string
  readonly sequence: readonly MockLlmBehavior[]
  readonly lastBehavior: MockLlmBehavior
  readonly repeatLast: boolean
  readonly randomSeed: number
  readonly randomWeights: readonly (readonly [ConcreteMockLlmBehavior, number])[]
  readonly successText: string
  readonly partialText: string
  readonly reasoningText: string
  readonly chunkSize: number
  readonly chunkDelayMs: number
  readonly disconnectDelayMs: number
  readonly retryAfterMs: number
  readonly requestId?: string
  readonly toolName: string
  readonly toolArguments: string
  readonly onEvent?: (event: MockLlmServerEvent) => void
}

const DEFAULT_SUCCESS_TEXT = 'mock response recovered'
const DEFAULT_PARTIAL_TEXT = 'discarded partial response'
const DEFAULT_REASONING_TEXT = 'mock reasoning'
const CONCRETE_BEHAVIORS = new Set<string>(MOCK_LLM_BEHAVIORS.filter(behavior => behavior !== 'random'))

function boundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`llm-mock-server: ${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function resolveOptions(options: MockLlmServerOptions): ResolvedOptions {
  const host = options.host ?? '127.0.0.1'
  const port = boundedInteger('port', options.port ?? 0, 0, 65_535)
  const chunkSize = boundedInteger('chunkSize', options.chunkSize ?? 8, 1, Number.MAX_SAFE_INTEGER)
  const chunkDelayMs = boundedInteger(
    'chunkDelayMs',
    options.chunkDelayMs ?? 25,
    0,
    MAX_MOCK_LLM_TIMER_DELAY_MS,
  )
  const disconnectDelayMs = boundedInteger(
    'disconnectDelayMs',
    options.disconnectDelayMs ?? 10,
    0,
    MAX_MOCK_LLM_TIMER_DELAY_MS,
  )
  const retryAfterMs = boundedInteger(
    'retryAfterMs',
    options.retryAfterMs ?? 1_000,
    1,
    MAX_MOCK_LLM_TIMER_DELAY_MS,
  )
  const randomSeed = boundedInteger(
    'randomSeed',
    options.randomSeed ?? randomBytes(4).readUInt32LE(0),
    0,
    0xffff_ffff,
  )
  const successText = options.successText ?? DEFAULT_SUCCESS_TEXT
  const partialText = options.partialText ?? DEFAULT_PARTIAL_TEXT
  const reasoningText = options.reasoningText ?? DEFAULT_REASONING_TEXT
  const toolName = options.toolName ?? 'mock_tool'
  const toolArguments = options.toolArguments ?? '{"value":"mock"}'

  if (host.length === 0) throw new Error('llm-mock-server: host must not be empty')
  if (options.sequence.length === 0) throw new Error('llm-mock-server: sequence must not be empty')
  const lastBehavior = options.sequence.reduce((_previous, behavior) => behavior)
  if (options.apiKey === '') throw new Error('llm-mock-server: apiKey must not be empty')
  if (successText.length === 0) throw new Error('llm-mock-server: successText must not be empty')
  if (partialText.length === 0) throw new Error('llm-mock-server: partialText must not be empty')
  if (reasoningText.length === 0) throw new Error('llm-mock-server: reasoningText must not be empty')
  if (toolName.length === 0) throw new Error('llm-mock-server: toolName must not be empty')
  if (options.requestId === '') throw new Error('llm-mock-server: requestId must not be empty')
  try {
    JSON.parse(toolArguments)
  } catch {
    throw new Error('llm-mock-server: toolArguments must be valid JSON')
  }

  const configuredWeights = options.randomWeights ?? DEFAULT_MOCK_LLM_RANDOM_WEIGHTS
  const randomWeights: Array<readonly [ConcreteMockLlmBehavior, number]> = []
  for (const [behavior, weight] of Object.entries(configuredWeights)) {
    if (!CONCRETE_BEHAVIORS.has(behavior)) {
      throw new Error(`llm-mock-server: randomWeights contains unknown concrete behavior ${JSON.stringify(behavior)}`)
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`llm-mock-server: random weight for ${behavior} must be a non-negative finite number`)
    }
    if (weight > 0) randomWeights.push([behavior as ConcreteMockLlmBehavior, weight])
  }
  if (randomWeights.length === 0) {
    throw new Error('llm-mock-server: randomWeights must contain at least one positive weight')
  }

  return {
    host,
    port,
    ...options.apiKey === undefined ? {} : { apiKey: options.apiKey },
    sequence: [...options.sequence],
    lastBehavior,
    repeatLast: options.repeatLast ?? false,
    randomSeed,
    randomWeights,
    successText,
    partialText,
    reasoningText,
    chunkSize,
    chunkDelayMs,
    disconnectDelayMs,
    retryAfterMs,
    ...options.requestId === undefined ? {} : { requestId: options.requestId },
    toolName,
    toolArguments,
    ...options.onEvent === undefined ? {} : { onEvent: options.onEvent },
  }
}

function emit(options: ResolvedOptions, event: MockLlmServerEvent): void {
  try {
    options.onEvent?.(Object.freeze(event))
  } catch (_telemetryObserverFailure) {
    // Test telemetry is observational; a broken observer cannot change provider wire behavior.
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  const body = Buffer.concat(chunks).toString('utf8')
  return body.length === 0 ? undefined : JSON.parse(body)
}

function splitText(text: string, size: number): string[] {
  const points = Array.from(text)
  const chunks: string[] = []
  for (let index = 0; index < points.length; index += size) chunks.push(points.slice(index, index + size).join(''))
  return chunks
}

function openSse(response: ServerResponse, contentType = 'text/event-stream; charset=utf-8'): void {
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  response.flushHeaders()
}

function writeSse(record: MockLlmRequestRecord, response: ServerResponse, payload: unknown): void {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
  record.chunksSent += 1
}

function writeDone(record: MockLlmRequestRecord, response: ServerResponse): void {
  writeSse(record, response, { type: 'message_stop' })
}

function finishRecord(
  options: ResolvedOptions,
  record: MockLlmRequestRecord,
  outcome: MockLlmRequestOutcome,
): void {
  if (record.outcome !== undefined) return
  record.outcome = outcome
  emit(options, {
    type: 'result',
    attempt: record.attempt,
    scriptBehavior: record.scriptBehavior,
    behavior: record.behavior,
    outcome,
    chunksSent: record.chunksSent,
  })
}

function httpError(
  options: ResolvedOptions,
  record: MockLlmRequestRecord,
  response: ServerResponse,
  status: number,
  message: string,
  code: string,
  type = 'mock_error',
): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (record.behavior === 'rate_limit') {
    headers['retry-after'] = String(Math.ceil(options.retryAfterMs / 1_000))
  }
  if (options.requestId !== undefined) headers['x-request-id'] = options.requestId
  response.writeHead(status, headers)
  response.end(JSON.stringify({ error: { message, type, code } }))
  finishRecord(options, record, 'completed')
}

function startMessage(record: MockLlmRequestRecord, response: ServerResponse): void {
  writeSse(record, response, {
    type: 'message_start',
    message: { id: 'mock-message', type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } },
  })
}

function startText(record: MockLlmRequestRecord, response: ServerResponse, index: number): void {
  writeSse(record, response, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
}

function terminalChunk(reason: string, outputTokens: number): unknown {
  return {
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }
}

async function pause(milliseconds: number, response: ServerResponse): Promise<boolean> {
  if (milliseconds === 0) return !response.destroyed
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  response.once('close', stop)
  try {
    await delay(milliseconds, undefined, { signal: controller.signal })
    return true
  } catch (_responseClosed) {
    // The timer only receives this response-owned abort signal; closing the response cancels its wait.
    return false
  } finally {
    response.off('close', stop)
  }
}

async function streamText(
  options: ResolvedOptions,
  record: MockLlmRequestRecord,
  response: ServerResponse,
  text: string,
  delayMs: number,
  index = 0,
): Promise<boolean> {
  for (const chunk of splitText(text, options.chunkSize)) {
    writeSse(record, response, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } })
    if (!await pause(delayMs, response)) return false
  }
  return true
}

async function completeText(
  options: ResolvedOptions,
  record: MockLlmRequestRecord,
  response: ServerResponse,
  reason: 'end_turn' | 'max_tokens',
  delayMs: number,
  index = 0,
): Promise<void> {
  startText(record, response, index)
  if (!await streamText(options, record, response, options.successText, delayMs, index)) {
    finishRecord(options, record, 'client_closed')
    return
  }
  writeSse(record, response, { type: 'content_block_stop', index })
  writeSse(record, response, terminalChunk(reason, Array.from(options.successText).length))
  writeDone(record, response)
  response.end()
  finishRecord(options, record, 'completed')
}

async function disconnect(
  options: ResolvedOptions,
  record: MockLlmRequestRecord,
  response: ServerResponse,
): Promise<void> {
  if (!await pause(options.disconnectDelayMs, response)) {
    finishRecord(options, record, 'client_closed')
    return
  }
  finishRecord(options, record, 'reset')
  response.destroy()
}

function toolCallChunks(options: ResolvedOptions): readonly unknown[] {
  const midpoint = Math.max(1, Math.floor(options.toolArguments.length / 2))
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'mock-call-1', name: options.toolName, input: {} } },
    ...[options.toolArguments.slice(0, midpoint), options.toolArguments.slice(midpoint)].map(partial => ({
      type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial },
    })),
    { type: 'content_block_stop', index: 0 },
  ]
}

async function runBehavior(
  options: ResolvedOptions,
  record: MockLlmRequestRecord,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  switch (record.behavior) {
    case 'script_exhausted':
      httpError(options, record, response, 500, 'mock script exhausted', 'MOCK_SCRIPT_EXHAUSTED')
      return
    case 'connection_reset':
      finishRecord(options, record, 'reset')
      request.socket.destroy()
      return
    case 'stream_disconnect':
      openSse(response)
      await disconnect(options, record, response)
      return
    case 'empty':
      openSse(response)
      startMessage(record, response)
      writeSse(record, response, terminalChunk('end_turn', 0))
      writeDone(record, response)
      response.end()
      finishRecord(options, record, 'completed')
      return
    case 'empty_body':
      openSse(response)
      response.end()
      finishRecord(options, record, 'completed')
      return
    case 'stream_eof':
      openSse(response)
      startMessage(record, response)
      response.end()
      finishRecord(options, record, 'completed')
      return
    case 'partial_eof':
      openSse(response)
      startMessage(record, response)
      startText(record, response, 0)
      await streamText(options, record, response, options.partialText, 0)
      response.end()
      finishRecord(options, record, 'completed')
      return
    case 'partial_disconnect':
      openSse(response)
      startMessage(record, response)
      startText(record, response, 0)
      if (!await streamText(options, record, response, options.partialText, options.chunkDelayMs)) return
      await disconnect(options, record, response)
      return
    case 'stall':
      openSse(response)
      finishRecord(options, record, 'stalled')
      return
    case 'malformed_json':
      openSse(response)
      writeSse(record, response, '{not-json')
      writeDone(record, response)
      response.end()
      finishRecord(options, record, 'completed')
      return
    case 'malformed_event':
      openSse(response)
      writeSse(record, response, { type: 'content_block_start', index: 0, content_block: null })
      writeDone(record, response)
      response.end()
      finishRecord(options, record, 'completed')
      return
    case 'wrong_content_type':
      openSse(response, 'application/json')
      startMessage(record, response)
      await completeText(options, record, response, 'end_turn', 0)
      return
    case 'rate_limit':
      httpError(options, record, response, 429, 'mock rate limit', 'rate_limit')
      return
    case 'server_error':
      httpError(options, record, response, 500, 'mock server error', 'server_error')
      return
    case 'service_unavailable':
      httpError(options, record, response, 503, 'mock service unavailable', 'service_unavailable')
      return
    case 'auth_error':
      httpError(options, record, response, 401, 'mock authentication failed', 'invalid_api_key')
      return
    case 'invalid_request':
      httpError(options, record, response, 400, 'mock invalid request', 'invalid_request')
      return
    case 'context_overflow':
      httpError(
        options,
        record,
        response,
        400,
        'mock input exceeds the model context window',
        'context_length_exceeded',
        'invalid_request_error',
      )
      return
    case 'quota_exceeded':
      httpError(options, record, response, 429, 'mock insufficient quota', 'insufficient_quota')
      return
    case 'success':
      openSse(response)
      startMessage(record, response)
      await completeText(options, record, response, 'end_turn', 0)
      return
    case 'reasoning_success':
      openSse(response)
      startMessage(record, response)
      writeSse(record, response, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      for (const chunk of splitText(options.reasoningText, options.chunkSize)) {
        writeSse(record, response, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } })
      }
      writeSse(record, response, { type: 'content_block_stop', index: 0 })
      await completeText(options, record, response, 'end_turn', 0, 1)
      return
    case 'tool_call_success':
      openSse(response)
      startMessage(record, response)
      for (const chunk of toolCallChunks(options)) writeSse(record, response, chunk)
      writeSse(record, response, terminalChunk('tool_use', 2))
      writeDone(record, response)
      response.end()
      finishRecord(options, record, 'completed')
      return
    case 'max_tokens':
      openSse(response)
      startMessage(record, response)
      await completeText(options, record, response, 'max_tokens', 0)
      return
    case 'slow_success':
      openSse(response)
      startMessage(record, response)
      await completeText(options, record, response, 'end_turn', options.chunkDelayMs)
      return
  }
}

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61)
    return ((mixed ^ mixed >>> 14) >>> 0) / 0x1_0000_0000
  }
}

function chooseRandomBehavior(
  weights: readonly (readonly [ConcreteMockLlmBehavior, number])[],
  random: () => number,
): ConcreteMockLlmBehavior {
  const total = weights.reduce((sum, entry) => sum + entry[1], 0)
  let draw = random() * total
  for (const [behavior, weight] of weights) {
    if (draw < weight) return behavior
    draw -= weight
  }
  // Floating-point subtraction can only leave a rounding residue at the upper boundary.
  /* v8 ignore next -- seededRandom is strictly less than one; this guards floating-point residue only */
  return (weights.at(-1) as readonly [ConcreteMockLlmBehavior, number])[0]
}

/**
 * Start a local Messages server that consumes one configured behavior
 * per accepted request. Only a `POST` path ending in `/v1/messages` consumes the script;
 * invalid routes, methods, API keys, and JSON receive ordinary 4xx
 * responses. Closing the handle terminates stalled connections.
 *
 * @param options - listener, script, response content, timing, and telemetry options.
 * @returns the listening handle after the port is bound.
 */
export async function startMockLlmServer(options: MockLlmServerOptions): Promise<MockLlmServer> {
  const resolved = resolveOptions(options)
  const requests: MockLlmRequestRecord[] = []
  const random = seededRandom(resolved.randomSeed)
  let cursor = 0

  const selectBehavior = (): {
    scriptBehavior: MockLlmBehavior | 'script_exhausted'
    behavior: ConcreteMockLlmBehavior | 'script_exhausted'
  } => {
    const selected = resolved.sequence[cursor]
    cursor += 1
    const scriptBehavior = selected
      ?? (resolved.repeatLast ? resolved.lastBehavior : 'script_exhausted')
    return {
      scriptBehavior,
      behavior: scriptBehavior === 'random'
        ? chooseRandomBehavior(resolved.randomWeights, random)
        : scriptBehavior,
    }
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    /* v8 ignore next -- node:http server requests always carry a URL despite the shared optional type */
    const path = new URL(request.url ?? '/', 'http://mock.invalid').pathname
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end()
      return
    }
    if (!path.endsWith('/v1/messages')) {
      response.writeHead(404).end()
      return
    }
    if (resolved.apiKey !== undefined && request.headers['x-api-key'] !== resolved.apiKey) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid mock API key', code: 'invalid_api_key' } }))
      return
    }

    let body: unknown
    try {
      body = await readJsonBody(request)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'request body must be valid JSON', code: 'invalid_json' } }))
      return
    }

    const selected = selectBehavior()
    const record: MockLlmRequestRecord = {
      attempt: requests.length + 1,
      scriptBehavior: selected.scriptBehavior,
      behavior: selected.behavior,
      path,
      headers: { ...request.headers },
      body,
      chunksSent: 0,
    }
    requests.push(record)
    response.once('close', () => {
      if (!response.writableFinished && record.outcome === undefined) {
        finishRecord(resolved, record, 'client_closed')
      }
    })
    emit(resolved, {
      type: 'request',
      attempt: record.attempt,
      scriptBehavior: record.scriptBehavior,
      behavior: record.behavior,
      path,
    })
    await runBehavior(resolved, record, request, response)
  }

  const server = createServer((request, response) => {
    /* v8 ignore start -- last-resort containment for Node response failures after validated test inputs */
    handle(request, response).catch((error: unknown) => {
      const record = requests.at(-1)
      if (record !== undefined) finishRecord(resolved, record, 'server_error')
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'mock server handler failed', code: 'MOCK_HANDLER_FAILED' } }))
    })
    /* v8 ignore stop */
  })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => (closing ??= new Promise((resolveClose) => {
    server.close(() => { resolveClose() })
    server.closeAllConnections()
  }))

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(resolved.port, resolved.host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address() as AddressInfo
  const advertisedHost = isIP(resolved.host) === 6 ? `[${resolved.host}]` : resolved.host
  return {
    baseURL: `http://${advertisedHost}:${address.port}`,
    port: address.port,
    randomSeed: resolved.randomSeed,
    requests,
    close,
  }
}
