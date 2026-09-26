/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SdkEncodedImageBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
}

function encodedImage(block: SessionPromptParams['contentBlocks'][number]): block is SdkEncodedImageBlock {
  return block.type === 'image' && 'data' in block
}

async function durablePromptContent(ctx: Context, blocks: SessionPromptParams['contentBlocks']): Promise<ContentBlock[]> {
  const images = blocks.filter(encodedImage)
  if (images.length === 0) return blocks as ContentBlock[]
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('SDK image prompt requires an attachment store')
  const refs = await admitEncodedImages(attachments, images.map((image): EncodedImageAttachment => ({
    data: image.data,
    mediaType: image.mimeType,
  })))
  let next = 0
  return blocks.map(block => encodedImage(block)
    ? { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
    : block)
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private initialized = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined
          ? {}
          : { lastAssistantMessage: [...info.lastAssistantMessage] }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Validate and configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.reasoningEffort !== undefined
      && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.length === 0)) {
      throw new TypeError('initialize reasoningEffort must be a non-empty string')
    }
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const cwd = resolve(params.cwd)
    const provider = params.provider
    const model = params.model
    const reasoningEffort = params.reasoningEffort === undefined
      ? undefined
      : ReasoningEffortId(params.reasoningEffort)
    if (!this.hasAdapterFor(provider)) {
      if (provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek)
    }
    // Adapter presence was read from this service above; a successful fallback mount also requires it.
    const llm = this.ctx.get('llm') as LlmRuntime
    await llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens },
    })
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.maxTokens = params.maxTokens
    this.initialized = true
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery.
    this.assertLiveAgent(rec, params.sessionId)
    const content = await durablePromptContent(this.ctx, params.contentBlocks)
    // Attachment admission crosses an async boundary where shutdown or an
    // agent-loop reload may detach the retained handle.
    this.assertLiveAgent(rec, params.sessionId)
    const message = createUserMessage({
      content,
      source: { kind: 'user' },
    })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
    const handle = await this.ctx.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      },
    })
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
