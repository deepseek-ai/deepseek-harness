/**
 * Shared execution policy for model-backed session-title providers: route
 * preparation, input/token/time bounds, cancellation, exact auxiliary request
 * logging, and stream assembly. Title wording, length targets, reasoning
 * selection, and output interpretation belong to each provider.
 * @module @deepseek-ai/dsh-session-title-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-title-llm': { kind: 'dsh-session-title-llm' } & ContextFormed
  }
}

import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  Message,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleModelIdentity,
  SessionTitleProviderRequest,
} from '@deepseek-ai/dsh-session-title'

/** Exact model-visible request recorded before one auxiliary title dispatch. */
export interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact human `user/message` seqs represented in `messages`. */
  readonly messageSeqs: SessionSeq[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelIdentity
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
  /** Resolved reasoning effort when recorded; older requests can omit it. */
  readonly reasoningEffort?: ReasoningEffortId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one session-title model request. */
    'session/title-llm-request': SessionTitleLlmRequestEventData
  }
}

/** Capability-owned timeout reason code for auxiliary title requests. */
export const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** Required execution controls for one model-backed title request. */
export interface SessionTitleLlmConfig {
  /** Maximum UTF-8 bytes in the provider-prepared user input. */
  readonly maxInputBytes: number
  /** Output-token cap for the title request, independent of conversation requests. */
  readonly maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
}

/** Validated immutable execution controls. */
export interface ResolvedSessionTitleLlmConfig extends SessionTitleLlmConfig {}

/** Shared Loader field schemas with no library defaults. */
export const SessionTitleLlmConfigFields = {
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
}

/** Shared Loader schema with no library defaults. */
export const SessionTitleLlmConfigSchema: z<SessionTitleLlmConfig> = z.object(SessionTitleLlmConfigFields)

/** Complete execution-control key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'provider',
  'model',
])

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-llm: ${name} must be a positive integer`)
  }
}

/**
 * Validate and detach required execution controls.
 * @param config - untrusted execution configuration.
 * @returns immutable controls with optional route absence preserved.
 */
export function resolveSessionTitleLlmConfig(
  config: SessionTitleLlmConfig,
): ResolvedSessionTitleLlmConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-title-llm: configuration is required')
  }
  const value = candidate as SessionTitleLlmConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  assertPositiveInteger('maxInputBytes', value.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', value.maxOutputTokens)
  assertPositiveInteger('timeoutMs', value.timeoutMs)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`session-title-llm: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  const hasProvider = value.provider !== undefined
  const hasModel = value.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('session-title-llm: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('session-title-llm: provider and model overrides must be non-empty strings')
  }
  return deepFreeze({ ...value })
}

/**
 * Provider-prepared model input, source-message attribution, and the
 * provider-owned reasoning selector forwarded to `ctx.llm.prepareCall`.
 */
export interface SessionTitleLlmPreparedRequest {
  /** Exact system prompt supplied by the provider. */
  readonly system: string
  /** Exact user message text supplied by the provider, including any framing. */
  readonly input: string
  /** Exact human `user/message` seqs represented by `input`, in log order. */
  readonly messageSeqs: readonly SessionSeq[]
  /**
   * Provider-owned reasoning selection for the captured route. The execution
   * module combines only the returned effort with its fixed output-token cap.
   * @param model - detached, deeply frozen metadata from the captured adapter generation.
   * @returns a supported effort id, or `undefined` to use the route's normal default.
   */
  readonly selectReasoningEffort: (model: Readonly<LlmResolvedModelInfo>) => ReasoningEffortId | undefined
}

/** Terminal finish kinds forwarded to a provider for its own interpretation. */
export type SessionTitleLlmFinish = Extract<FinishReason, { kind: 'stop' | 'tool-calls' | 'max-tokens' }>

/** Assembled auxiliary model response for one provider to interpret. */
export interface SessionTitleLlmResponse {
  /** Assembled content blocks in stream order; the provider rejects unwanted block types. */
  readonly blocks: readonly ContentBlock[]
  /** Terminal finish reason forwarded without title-output interpretation. */
  readonly finish: SessionTitleLlmFinish
  /** Exact auxiliary model route that produced the response. */
  readonly model: SessionTitleModelIdentity
}

/** Resolve the explicit pair or the exact route captured from `request/header`. */
function resolveRoute(
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
): SessionTitleModelIdentity {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  if (request.route === undefined) {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  return request.route
}

/**
 * Classify one terminal finish reason. Operational failures throw; every other
 * terminal kind is returned for the provider to accept or reject.
 * @param finish - terminal finish reason from the assembled stream.
 * @returns the provider-facing finish reason.
 * @throws {Error} on a provider or caller abort, or an impossible finish variant.
 */
function terminalFinish(finish: FinishReason): SessionTitleLlmFinish {
  switch (finish.kind) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
      return finish
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      throw error
    }
    /* v8 ignore next -- closed FinishReason union exhaustiveness guard */
    default: return assertNever(finish, 'FinishReason')
  }
}

/**
 * Execute one prepared auxiliary title request.
 *
 * The provider owns the system prompt, user input, reasoning selection, and
 * output interpretation. This function owns route preparation, the final input
 * byte limit, the output-token cap, the end-to-end deadline, cancellation, the
 * exact `session/title-llm-request` record, and stream assembly.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated execution controls.
 * @param request - service-owned session, route, message snapshot, current title, and cancellation.
 * @param titleProvider - registered title-provider identity recorded with the request.
 * @param prepared - provider system prompt, input, source-message seqs, and reasoning selector.
 * @returns assembled response blocks, terminal finish, and the exact route used.
 * @throws {Error} when input bounds, route preparation, the deadline, cancellation, or an operational finish failure occurs.
 */
export async function executeSessionTitleLlm(
  ctx: Context,
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
  titleProvider: SessionTitleProviderId,
  prepared: SessionTitleLlmPreparedRequest,
): Promise<SessionTitleLlmResponse> {
  request.signal.throwIfAborted()
  if (prepared.messageSeqs.length === 0) {
    throw new Error('session-title-llm: at least one source message is required')
  }
  const inputBytes = Buffer.byteLength(prepared.input, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`session-title-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  const route = resolveRoute(config, request)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: prepared.input }],
    source: { kind: 'dsh-session-title-llm' },
  })]
  using callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)
  const maxTokens = config.maxOutputTokens
  const call = await ctx.llm.prepareCall({
    ...route,
    maxTokens,
  }, callDeadline.signal, (controls, model) => {
    const effort = prepared.selectReasoningEffort(model)
    return { ...controls, ...effort === undefined ? {} : { reasoningEffort: effort } }
  })
  const options: GenerateOptions = deepFreeze({
    ...call.config,
    messages,
    system: prepared.system,
    sessionId: request.session.id,
    purpose: 'session-title',
    signal: callDeadline.signal,
  })
  request.session.append('session/title-llm-request', {
    titleProvider,
    messageSeqs: [...prepared.messageSeqs],
    route,
    system: prepared.system,
    messages,
    maxTokens,
    ...call.config.reasoningEffort === undefined ? {} : { reasoningEffort: call.config.reasoningEffort },
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const finish = terminalFinish(assembler.finish)
  return { blocks: assembler.blocks(), finish, model: route }
}
