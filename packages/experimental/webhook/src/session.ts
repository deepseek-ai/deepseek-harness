/** Workspace-backed Session creation for one settled webhook rule result. */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { boundContextSummary, createUserMessage, errorChain, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WebhookRuleId } from './brand.ts'
import type { VerifiedWebhookDelivery, WebhookSessionRequest } from './types.ts'

/** Detached values the creation transaction keeps across asynchronous preflight. */
interface ResolvedWebhookSessionRequest {
  readonly workspacePath: string
  readonly title: string
  readonly prompt: string
  readonly agentPreset: string
  readonly permissionPreset: string
  readonly modelSelection: ModelSelection
  readonly agentOptions: {
    readonly provider: string
    readonly model: string
    readonly maxTokens?: number
  }
}

/** Require one non-empty string field from an untyped rule result. */
function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`webhook Session request ${field} must be a non-empty string`)
  }
  return value
}

/** Snapshot and validate a same-process rule result before crossing awaits. */
function resolveRequest(ctx: Context, input: WebhookSessionRequest): ResolvedWebhookSessionRequest {
  const candidate: unknown = input
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('webhook rule result must be null or a Session request object')
  }
  const record = candidate as Record<string, unknown>
  const workspacePath = requiredString(record, 'workspacePath')
  if (!isAbsolute(workspacePath)) {
    throw new TypeError(`webhook Session request workspacePath must be absolute, got ${JSON.stringify(workspacePath)}`)
  }
  const title = requiredString(record, 'title')
  const prompt = requiredString(record, 'prompt')
  const agentPreset = requiredString(record, 'agentPreset')
  const permissionPreset = requiredString(record, 'permissionPreset')
  const model = record['model']
  if (model !== undefined && (model === null || typeof model !== 'object' || Array.isArray(model))) {
    throw new TypeError('webhook Session request model must be an object')
  }
  let agentOptions: ResolvedWebhookSessionRequest['agentOptions']
  let modelSelection: ModelSelection
  if (model === undefined) {
    const selected = ctx.agentDefaultModel.currentSelection()
    agentOptions = { provider: selected.provider, model: selected.model }
    modelSelection = { ...selected }
  } else {
    const modelRecord = model as Record<string, unknown>
    const provider = requiredString(modelRecord, 'provider')
    const modelId = requiredString(modelRecord, 'model')
    const maxTokens = modelRecord['maxTokens']
    if (maxTokens !== undefined
      && (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
      throw new TypeError('webhook Session request model.maxTokens must be a positive safe integer')
    }
    agentOptions = {
      provider,
      model: modelId,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
    modelSelection = { provider, model: modelId }
  }
  return { workspacePath, title, prompt, agentPreset, permissionPreset, modelSelection, agentOptions }
}

/** Log a rollback failure without replacing the operation's original failure. */
function reportRollbackFailure(ctx: Context, subject: string, error: unknown): void {
  ctx.logger.warn(`webhook: ${subject} rollback failed: ${errorChain(error)}`)
}

/** Apply the creation-time selection until its first durable request header exists. */
function installInitialModelSelection(agentCtx: Context, selection: ModelSelection): void {
  agentCtx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (agent.session.requestHeader() !== undefined
      || resolved.provider !== selection.provider
      || resolved.model !== selection.model) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  })
}

/**
 * Create, attach, title, configure, and prompt one ordinary root Session.
 * Successful prompt admission ends webhook ownership of the operation; the
 * Agent remains lifecycle-owned by `ctx` and follows normal Session behavior.
 *
 * @param ctx - untraced runtime context that owns the resulting Agent.
 * @param delivery - exact verified provider delivery recorded in the message source.
 * @param ruleId - rule that returned the request.
 * @param request - same-process rule result.
 * @param signal - registration lifetime cancellation through publication.
 */
export async function createWebhookSession(
  ctx: Context,
  delivery: VerifiedWebhookDelivery,
  ruleId: WebhookRuleId,
  request: WebhookSessionRequest,
  signal: AbortSignal,
): Promise<void> {
  const resolved = resolveRequest(ctx, request)
  ctx.permissionPresets.resolve(resolved.permissionPreset)
  const preset = await ctx.agentPresets.resolve(resolved.agentPreset)
  await using presetScope = await ctx.agentPresets.acquireScope(preset.id)
  void presetScope
  signal.throwIfAborted()

  const workspace = await ctx.workspaceRegistry.create(resolved.workspacePath)
  signal.throwIfAborted()
  const sessionId = brandString<SessionId>(`webhook-${randomUUID()}`)
  const handle = await ctx.agents.create({
    sessionId,
    signal,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions: resolved.agentOptions,
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, preset.id)
      installInitialModelSelection(agentCtx, resolved.modelSelection)
    },
  })

  let attached = false
  try {
    signal.throwIfAborted()
    await workspace.attachSession(sessionId)
    attached = true
    signal.throwIfAborted()
    ctx.permissionPresets.set(handle.agent.session, resolved.permissionPreset)
    ctx.sessionTitle.rename(handle.agent.session, resolved.title)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: resolved.prompt }],
      source: {
        kind: 'webhook',
        provider: delivery.kind,
        source: delivery.source,
        deliveryId: delivery.deliveryId,
        ruleId,
        form: 'notice',
        summary: boundContextSummary(`${delivery.kind} webhook handled by ${ruleId}`),
      },
    }))
  } catch (error: unknown) {
    if (attached) {
      try {
        await workspace.detachSession(sessionId)
      } catch (rollbackError: unknown) {
        reportRollbackFailure(ctx, `Workspace detach for Session "${sessionId}"`, rollbackError)
      }
    }
    try {
      await handle.dispose()
    } catch (rollbackError: unknown) {
      reportRollbackFailure(ctx, `Agent disposal for Session "${sessionId}"`, rollbackError)
    }
    throw error
  }
}
