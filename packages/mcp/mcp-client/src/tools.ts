/**
 * Tool bridge: discovers MCP tools, registers them on the harness ToolRuntime
 * under deterministic server-qualified public names, and handles re-sync when
 * the server's tool list changes.
 *
 * Naming contract (see the mcp-client Agent Note "Naming invariants"): every MCP tool
 * has the stable identity `(serverName, rawName)`; the model-facing public name
 * is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
 * constraints. The raw name is only ever sent on the wire (`tools/call`); the
 * public name is never parsed to recover it.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { specTypeSchemas, type Client, type ImageContent, type JsonSchemaType, type Tool } from '@modelcontextprotocol/client'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import type { Context } from '@deepseek-ai/cordis'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describeError, McpLocalError, mcpRequestError, McpToolError } from './diagnostic.ts'
import type { McpToolRegistrar } from './status.ts'
import type { McpToolLoader } from './tool-loading.ts'

/** Resolved options relevant to tool bridging. */
export interface ToolBridgeOptions {
  serverName: string
  toolCallTimeoutMs: number
  /** Generation cancellation combined with each tool execution's signal. */
  signal: AbortSignal
  /**
   * Remove secret values from tool-call failures before they reach callers;
   * a failure keeps its `name` and `code`.
   * @param text - transport or protocol failure text, or MCP `isError` result text.
   * @returns the text with secret values replaced.
   */
  redact?: (text: string) => string
  /** On-demand loading: the generation is published to this loader instead of the tool registry. */
  loader?: McpToolLoader
  /** Registers the generation's tools and records them for the instance's status handle. */
  registrar: McpToolRegistrar
  /** Supervised connection: lets a call the server refused for its session be sent once more after the reconnect. */
  recovery?: McpCallRecovery
}

/**
 * One attempt of an upstream tool call on the connection generation that listed the tool.
 * @param args - model arguments admitted by the ToolRuntime.
 * @param execution - exact ToolRuntime invocation, including its Agent and cancellation.
 * @returns the raw MCP result. Rejects with {@link McpSessionRefused} when the server refused the attempt's own
 *   request because it no longer knows the session.
 */
export type McpToolSend = (args: Record<string, unknown>, execution: ToolExecution) => Promise<unknown>

/** What a request reports when the server refused it for its session and no second attempt returned a result. */
const SESSION_EXPIRED_NOT_RUN = 'MCP server session expired; this call was not run. A new call may succeed after the client reconnects. State the server kept for the expired session may be lost.'

/**
 * The server refused a request because it no longer knows the session, so the request did not run
 * (`MCP_SERVER_UNAVAILABLE`).
 */
export class McpSessionRefused extends McpToolError {
  constructor(
    /**
     * Resolves to the attempts of the connection that replaces the refused one, keyed by raw tool name, or to
     * undefined when the next connection attempt does not connect.
     */
    readonly replacement: Promise<ReadonlyMap<string, McpToolSend> | undefined>,
  ) {
    super(SESSION_EXPIRED_NOT_RUN, 'MCP_SERVER_UNAVAILABLE')
  }
}

/** Supervisor state a tool call needs to be sent again on a replacement connection. */
export interface McpCallRecovery {
  /**
   * Classify the rejection of one request sent on the generation being synchronized.
   * @param error - the value the request rejected with.
   * @returns the failure to report when the server refused that request for its session; undefined for any other
   *   rejection.
   */
  refusal(error: unknown): McpSessionRefused | undefined
  /**
   * Receive a generation's attempts once its tools are registered.
   * @param sends - one attempt function per raw tool name.
   */
  publish(sends: ReadonlyMap<string, McpToolSend>): void
}

/**
 * Registration failed after the prior generation was removed and partial
 * registrations were rolled back (`MCP_TOOL_REGISTRATION_FAILED`).
 */
export class McpToolRegistrationError extends McpLocalError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'MCP_TOOL_REGISTRATION_FAILED', options)
  }
}

/** State for one sync generation: the current set of disposers keyed by public name. */
export type ToolDisposers = Map<string, () => void>

/**
 * Canonical MCP result exposed to PTC mode without discarding protocol blocks.
 * Each image block admitted to durable model context also carries its `attachment` reference.
 */
export type McpResult<Structured extends JsonValue = JsonValue> = {
  content: JsonValue[]
  structuredContent?: Structured
}

/**
 * DeepSeek function-name contract: at most 64 characters. Wire-protocol
 * constant, not configuration.
 */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** Raster formats supported by the durable attachment vocabulary. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Derive the model-facing public name for one MCP tool.
 *
 * Deterministic pure function of `(serverName, rawName)`: the clean case is
 * `mcp__<serverName>__<rawName>` verbatim. When character replacement or
 * truncation to the DeepSeek function-name contract (64 chars,
 * `[A-Za-z0-9_-]`) changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into the
 * same public name.
 *
 * @param serverName - Stable local namespace from plugin config.
 * @param rawName - The MCP server's own tool name.
 * @returns The globally unique, model-facing ToolRuntime name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Sync the MCP server's tool list into the harness ToolRuntime.
 *
 * Two phases keep the swap safe:
 *
 * 1. Fetch: let the SDK aggregate `tools/list` and build the full next
 *    generation of `ToolDefinition`s under public names. Any failure here
 *    (network error or duplicate raw name) rejects
 *    and leaves the previous generation registered untouched.
 * 2. Swap: dispose the previous generation, register the new one; an
 *    on-demand server publishes it to its loader, which registers only the
 *    loader tool and the tools agents loaded. A registry
 *    conflict here can only mean a foreign registration squats on this
 *    server's `mcp__<serverName>__` namespace — the partial generation is
 *    rolled back (zero tools from this server), logged, and rejected so the
 *    supervisor closes the failed connection generation.
 *
 * @param client - Connected MCP Client instance used to list and call tools.
 * @param ctx - Cordis context providing the `tools` service for registration.
 * @param opts - server namespace, call timeout, generation signal, optional error formatter, and optional on-demand loader.
 * @param previous - Disposer map from the prior sync generation; disposed
 *   during the swap phase (only after the fetch phase succeeded).
 * @param eligible - Judged again at the commit point, after the listing
 *   settled: a sync whose generation was abandoned meanwhile (startup budget
 *   elapsed, connection closed) publishes nothing and leaves `previous`
 *   untouched.
 * @returns A map of registered public tool names to their unregister
 *   disposers — the exact set of live registrations owned by this server; an
 *   on-demand server's map holds only its loader's publication.
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
  eligible: () => boolean = () => true,
): Promise<ToolDisposers> {
  // Phase 1: fetch and build the next generation without touching the registry.
  const definitions = new Map<string, { rawName: string; definition: ToolDefinition }>()
  const sends = new Map<string, McpToolSend>()
  const response = client.getServerCapabilities()?.tools === undefined
    ? { tools: [] }
    : await client.listTools(undefined, { cacheMode: 'refresh', signal: opts.signal })
  const outputValidators = new AjvJsonSchemaValidator()
  for (const tool of response.tools) {
    const publicName = publicToolName(opts.serverName, tool.name)
    if (definitions.has(publicName)) {
      throw new Error(
        `mcp-client(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
      )
    }
    if (publicName === opts.loader?.name) {
      ctx.logger.warn(`mcp-client(${opts.serverName}): server tool "${tool.name}" is not offered because its name is the on-demand loader's`)
      continue
    }
    // The bridge checks structured output itself: the SDK reports its local check as a
    // ProtocolError indistinguishable from a server's JSON-RPC error.
    const { outputSchema: _outputSchema, ...callDefinition } = tool
    const outputCheck = compileOutputCheck(outputValidators, tool)
    const invalidResult = (reason: string): McpToolError => {
      const message = `Tool "${tool.name}" returned an invalid MCP result: ${reason}`
      return new McpToolError(opts.redact === undefined ? message : opts.redact(message), 'MCP_INVALID_RESULT')
    }
    const send: McpToolSend = async (args, execution) => {
      // The generation closed and its tools await re-sync; the SDK would refuse the request unsent.
      if (opts.signal.aborted) {
        throw new McpToolError(`mcp-client(${opts.serverName}): server is disconnected`, 'MCP_SERVER_UNAVAILABLE')
      }
      if (outputCheck !== undefined && 'compileError' in outputCheck) {
        throw invalidResult(`its output schema cannot be compiled: ${outputCheck.compileError}`)
      }
      let result: Awaited<ReturnType<Client['callTool']>>
      try {
        result = await client.callTool(
          { name: tool.name, arguments: args },
          { signal: AbortSignal.any([execution.signal, opts.signal]),
            timeout: opts.toolCallTimeoutMs, toolDefinition: callDefinition },
        )
      } catch (error) {
        // The SDK reports an aborted signal as a request timeout; cancellation
        // and generation closure are reported as their own reasons instead.
        execution.signal.throwIfAborted()
        opts.signal.throwIfAborted()
        throw opts.recovery?.refusal(error) ?? mcpRequestError(error, `tool "${tool.name}"`, opts.redact)
      }
      if (result.isError !== true) {
        const failure = outputCheck === undefined ? undefined : outputCheck.check(result.structuredContent)
        if (failure !== undefined) throw invalidResult(failure)
        return result
      }
      if (opts.redact === undefined) return result
      return { isError: true, content: [{ type: 'text', text: opts.redact(extractText(result.content as JsonValue[], tool.name)) }] }
    }
    sends.set(tool.name, send)
    definitions.set(publicName, { rawName: tool.name, definition: createMcpToolDefinition(ctx, {
      name: publicName,
      rawName: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      taskRequired: tool.execution?.taskSupport === 'required',
      call: async (args, execution) => {
        try {
          return await send(args, execution)
        } catch (error) {
          if (!(error instanceof McpSessionRefused)) throw error
          return await sendAgain(tool.name, error, args, execution, opts.toolCallTimeoutMs)
        }
      },
    }) })
  }

  // Phase 2: swap generations — but only for a generation still entitled to
  // publish. The listing above is the slow await an abandonment can overtake;
  // state is published at its commit point or not at all.
  if (!eligible()) return previous
  for (const dispose of previous.values()) dispose()
  const disposers: ToolDisposers = new Map()
  try {
    if (opts.loader === undefined) {
      for (const [publicName, { definition }] of definitions) {
        disposers.set(publicName, opts.registrar.register(ctx, definition))
      }
    } else {
      const offered = new Map([...definitions.values()].map(({ rawName, definition }) => [rawName, definition]))
      disposers.set(opts.loader.name, opts.loader.publish(offered))
    }
  } catch (error) {
    // A conflict on an `mcp__<serverName>__`-qualified name means a foreign
    // registration occupies this server's namespace. Roll back so the model
    // sees either the full generation or none of it — never a partial set.
    for (const dispose of disposers.values()) dispose()
    ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
    throw new McpToolRegistrationError('MCP tool registration failed', { cause: error })
  }
  opts.recovery?.publish(sends)
  return disposers
}

/**
 * Send a call the server refused for its session once more, on the connection that replaces the refused one. The
 * wait for that connection ends with the caller's cancellation or after `timeoutMs`.
 * @param rawName - the refused call's upstream tool name.
 * @param refused - the first attempt's rejection.
 * @param args - the refused call's arguments, sent unchanged.
 * @param execution - the refused call's ToolRuntime invocation.
 * @param timeoutMs - longest wait for the replacement connection.
 * @returns the second attempt's raw MCP result. Rejects with `refused` when no replacement connects in time or the
 *   replacement does not list the tool; the second attempt's failures are rejected unchanged, including its own
 *   {@link McpSessionRefused}.
 */
async function sendAgain(
  rawName: string,
  refused: McpSessionRefused,
  args: Record<string, unknown>,
  execution: ToolExecution,
  timeoutMs: number,
): Promise<unknown> {
  // An abort listener added after the abort never runs.
  execution.signal.throwIfAborted()
  const ended = AbortSignal.any([execution.signal, AbortSignal.timeout(timeoutMs)])
  const waited: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const stop = (): void => { waited.resolve(undefined) }
  ended.addEventListener('abort', stop, { once: true })
  const sends = await Promise.race([refused.replacement, waited.promise])
  ended.removeEventListener('abort', stop)
  execution.signal.throwIfAborted()
  const send = sends?.get(rawName)
  if (send === undefined) throw refused
  return await send(args, execution)
}

/** A tool's compiled structured-output check, or why its advertised output schema cannot be compiled. */
type OutputCheck = { compileError: string } | {
  /**
   * @param structured - `structuredContent` of a successful result.
   * @returns why the value violates the advertised output schema, or undefined when it conforms.
   */
  check(structured: unknown): string | undefined
}

/**
 * Compile one tool's advertised output schema with the validator the SDK uses on Node.
 * @param validators - validator provider shared by one listing.
 * @param tool - listed tool; a tool without `outputSchema` needs no check.
 * @returns the check, a compile failure, or undefined without an output schema.
 */
function compileOutputCheck(validators: AjvJsonSchemaValidator, tool: Tool): OutputCheck | undefined {
  if (tool.outputSchema === undefined) return undefined
  let validate: ReturnType<AjvJsonSchemaValidator['getValidator']>
  try {
    // The listed schema is the wire object the SDK passes to the same provider; only its optional `$schema` typing differs.
    validate = validators.getValidator(tool.outputSchema as JsonSchemaType)
  } catch (error) {
    return { compileError: describeError(error) }
  }
  return {
    check(structured) {
      if (structured === undefined) return 'the tool has an output schema but returned no structured content'
      try {
        const result = validate(structured)
        return result.valid ? undefined : `structured content does not match the output schema: ${result.errorMessage}`
      } catch (error) {
        return `structured content could not be validated: ${describeError(error)}`
      }
    },
  }
}

/** Fields read from canonical content, including policy-owned value replacements. */
interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
  data?: string
  name?: string
  uri?: string
}

/** Async rich projection staged for one exact ToolRuntime execution. */
interface PreparedProjection {
  /** Canonical MCP value returned by execute before registry materialization. */
  value: McpResult
  /** Image-enriched or explicit-refusal projection prepared during execute. */
  content: ContentBlock[]
}

/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to JsonValue. */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** One upstream MCP tool and the callback that obtains its raw protocol result. */
export interface McpToolDefinitionOptions {
  /** ToolRuntime name presented to the model. */
  name: string
  /** Upstream name used in result diagnostics. */
  rawName: string
  /** Upstream model-facing description. */
  description: string
  /** Upstream JSON input schema. */
  inputSchema: Record<string, unknown>
  /** Advertised structured output schema, when present. */
  outputSchema?: unknown
  /** Whether the upstream tool requires the unsupported task execution extension. */
  taskRequired?: boolean
  /**
   * Obtain one raw MCP result from the provider.
   * @param args - model arguments admitted by the ToolRuntime.
   * @param execution - exact ToolRuntime invocation, including its Agent and cancellation.
   * @returns the external result object, validated before content projection.
   */
  call(args: Record<string, unknown>, execution: ToolExecution): Promise<unknown>
}

/**
 * Adapt an upstream MCP tool to canonical values and durable image content.
 * Registration, provider lifetime, deadlines, and transport belong to the caller.
 * @param ctx - plugin context carrying optional attachment and model services.
 * @param options - upstream tool fields and its raw-result callback.
 * @returns the unregistered ToolRuntime definition.
 */
export function createMcpToolDefinition(
  ctx: Context,
  options: McpToolDefinitionOptions,
): ToolDefinition {
  const { name, rawName, description, inputSchema } = options
  const projections = new WeakMap<ToolExecution, PreparedProjection>()
  return {
    name,
    description,
    parameters: inputSchema,
    output: createOutput(rawName, supportedOutputSchema(options.outputSchema)),
    execute: createExecutor(ctx, options, projections),
    projectContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) {
      const projection = projections.get(exec)
      if (projection === undefined) return undefined
      projections.delete(exec)
      if (result.isError) return undefined
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      return projection.content
    },
  }
}

/** Build the canonical result schema and existing Native text projection. */
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {}, description: 'MCP content blocks in order. An image block is an Image when the program can read it; otherwise it is the raw MCP block.' },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args: unknown, value: JsonValue) {
      const result = value as McpResult
      return [{ type: 'text', text: extractText(result.content, rawName) }]
    },
  }
}

/**
 * Invoke the caller-owned raw-result callback and prepare canonical content.
 * MCP isError results reject before image storage so ToolRuntime records failure.
 */
function createExecutor(
  ctx: Context,
  options: McpToolDefinitionOptions,
  projections: WeakMap<ToolExecution, PreparedProjection>,
): ToolDefinition['execute'] {
  const { rawName, taskRequired } = options
  return async (args: unknown, exec: ToolExecution) => {
    if (taskRequired) {
      throw new McpToolError(`Tool "${rawName}" requires task-based execution, which this bridge does not support`, 'MCP_UNSUPPORTED_TASK_EXECUTION')
    }
    // The agent loop passes `JSON.parse(model_arguments)` which is usually an
    // object, but can be any JSON value if the model misbehaves (outputs a bare
    // string/number/null). Fallback to {} lets the MCP server produce a
    // specific "missing required param" error the model can learn from.
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const parsed = specTypeSchemas.CallToolResult['~standard'].validate(await options.call(argsObj, exec))
    if (parsed.issues !== undefined) {
      throw new McpToolError(`Tool "${rawName}" returned an invalid MCP result: ${parsed.issues.map(issue => issue.message).join('; ')}`, 'MCP_INVALID_RESULT')
    }
    const result = parsed.value

    const content = result.content as unknown as JsonValue[]
    const text = extractText(content, rawName)

    // MCP isError → throw so ToolRuntime produces an isError result for the model.
    if (result.isError === true) {
      throw new McpToolError(text, 'MCP_TOOL_ERROR')
    }

    const value: McpResult = {
      content,
      ...result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent as JsonValue }
        : {},
    }
    if (!containsImage(content)) return value
    const { content: projected, attachments } = await prepareImageProjection(ctx, exec, content, rawName)
    const admitted: McpResult = attachments === undefined ? value : {
      ...value,
      content: content.map((block, index) => {
        const ref = attachments.get(index)
        return ref === undefined || !isRecord(block) ? block : { ...block, attachment: { ...ref } }
      }),
    }
    projections.set(exec, { value: admitted, content: projected })
    return admitted
  }
}

/** Whether an untrusted MCP content array contains a declared image block. */
function containsImage(content: JsonValue[]): boolean {
  return content.some(value => isRecord(value) && value.type === 'image')
}

/** Narrow one JSON value to a string-keyed object. */
function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a declared MIME string to the durable image vocabulary. */
function isImageMediaType(value: string): value is ImageMediaType {
  return IMAGE_MEDIA_TYPES.includes(value as ImageMediaType)
}

/** Decode one projected image without accepting base64 aliases. */
function decodeImage(block: ImageContent): SaveImageAttachment {
  if (!isImageMediaType(block.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  }
  if (!CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) {
    throw new Error('the image data is not canonical base64')
  }
  return { data, mediaType: block.mimeType }
}

/**
 * Resolve the active model route and durable store for an image-bearing result.
 * @param ctx - plugin context with optional services.
 * @param exec - exact tool execution whose agent supplies the latest route.
 * @returns the attachment store after exact positive image-capability proof.
 */
async function resolveImageAdmission(ctx: Context, exec: ToolExecution): Promise<AttachmentStore> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    throw new Error('the current model route could not be verified')
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (exec.signal.aborted) throw new Error('the tool call was canceled before image storage')
  return attachments
}

/** Stable diagnostic text for an image block that was not admitted. */
function imageDiagnostic(block: McpContentBlock, reason: string): string {
  const mediaType = block.mimeType ?? 'unknown media type'
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`
}

/**
 * Decode, preflight, and durably save one MCP result's ordered image batch.
 * Any refusal projects every image as text while retaining the canonical raw
 * value for programmatic callers.
 * @returns the projected content and, after admission, each image's reference by content index.
 */
async function prepareImageProjection(
  ctx: Context,
  exec: ToolExecution,
  content: JsonValue[],
  toolName: string,
): Promise<{ content: ContentBlock[]; attachments?: ReadonlyMap<number, ImageAttachmentRef> }> {
  const decoded: SaveImageAttachment[] = []
  const validationErrors = new Map<number, string>()
  const imageIndexes: number[] = []
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue
    imageIndexes.push(index)
    try {
      decoded.push(decodeImage(value as unknown as ImageContent))
    } catch (error: unknown) {
      // decodeImage owns every throw above and always produces Error.
      validationErrors.set(index, (error as Error).message)
    }
  }
  if (validationErrors.size > 0) {
    return { content: projectContent(content, toolName, (block, index) => ({
      type: 'text',
      text: imageDiagnostic(
        block,
        validationErrors.get(index) ?? 'another image in the same result was invalid',
      ),
    })) }
  }

  let attachments: AttachmentStore
  try {
    attachments = await resolveImageAdmission(ctx, exec)
  } catch (error: unknown) {
    // resolveImageAdmission contains provider failures and throws Error only.
    const reason = (error as Error).message
    return { content: projectContent(content, toolName, block => ({ type: 'text', text: imageDiagnostic(block, reason) })) }
  }

  try {
    const refs = await attachments.saveImages(decoded)
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset] as ImageAttachmentRef] as const))
    return {
      content: projectContent(content, toolName, (_block, index) => ({
        type: 'image',
        attachment: byIndex.get(index) as ImageAttachmentRef,
      })),
      attachments: byIndex,
    }
  } catch (error: unknown) {
    const reason = isImageAdmissionError(error)
      ? `image admission rejected the result: ${error.message}`
      : 'durable image storage rejected the result'
    return { content: projectContent(content, toolName, block => ({
      type: 'text',
      text: imageDiagnostic(block, reason),
    })) }
  }
}

/**
 * Extract text from an MCP content array into a single string.
 * - text blocks: join with '\n'
 * - image/audio/resource blocks: replaced with a placeholder
 *
 * Policy-owned canonical-value replacements may omit fields required on the MCP wire.
 */
function extractText(mcpContent: JsonValue[], toolName: string): string {
  const content = projectContent(mcpContent, toolName)
  // The default image projector below also returns text, so this local call
  // cannot produce a core image block.
  return content.map(block => (block as Extract<ContentBlock, { type: 'text' }>).text).join('\n')
}

/**
 * Project ordered MCP blocks into the core content vocabulary.
 * Text-like runs are newline-coalesced; admitted images split those runs at
 * their original position.
 */
function projectContent(
  mcpContent: JsonValue[],
  toolName: string,
  image: (block: McpContentBlock, index: number) => ContentBlock = block => ({
    type: 'text',
    text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
  }),
): ContentBlock[] {
  const projected: ContentBlock[] = []
  const text: string[] = []
  const flushText = (): void => {
    if (text.length === 0) return
    projected.push({ type: 'text', text: text.splice(0).join('\n') })
  }

  for (const [index, value] of mcpContent.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]')
      continue
    }
    const block = value as unknown as McpContentBlock
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) text.push(block.text)
        break
      case 'image':
        flushText()
        projected.push(image(block, index))
        break
      case 'resource_link':
        if (block.name === undefined || block.uri === undefined) {
          text.push('[resource link unavailable: the MCP block is missing its name or URI]')
        } else {
          text.push(`Resource link: ${block.name} (${block.uri})`)
        }
        break
      case 'audio':
        text.push(`[audio result unsupported: ${block.mimeType ?? 'unknown media type'}; raw audio data remains available to programmatic callers]`)
        break
      case 'resource':
        text.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]')
        break
      default:
        text.push(`[unsupported MCP content type: ${block.type}]`)
    }
  }
  flushText()
  return projected.length > 0
    ? projected
    : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }]
}
