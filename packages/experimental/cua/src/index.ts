/** Shared CUA tool execution, application consent, and object-runtime integration. */
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { NativeClient, NativeError, type NativeClientConfig, type NativeChannelFactory } from './native-client.ts'
import { MouseControl } from './mouse-control.ts'
import { withSystemPointerGuidance } from './guidance.ts'
import { CuaPermissionStore } from './permission-store.ts'
import { ApplicationAuthorizationResult, installCuaAccess } from './access.ts'
import type { CuaApplicationGrant, CuaApplicationId, CuaSystemPermission } from './access-types.ts'
import type { CuaAppHandle, CuaOperation, CuaStartupCapabilities } from './types.ts'
import { ApplicationIcon, AppResult, NativeScreenshotResult, Request, SystemPointerRequest, ScreenshotResult, StateResult, WindowsResult } from './protocol.ts'
import { CuaConfigFields } from './config.ts'
import { CuaCoordinates } from './coordinates.ts'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/cordis-plugin-loader'

export { CuaAccess } from './access.ts'
export type { CuaStartupCapabilities } from './types.ts'

/** Native executable and per-operation resource bounds. */
export interface CuaConfig {
  /** Ask once per live Session before an explicitly requested system-pointer move. */
  requireSystemPointerApproval: boolean
  /** Register tools for Agents using this preset; defaults to ptc. False enables global registration. */
  agentPreset: string | false
  /** Legacy grants imported once into profile-scoped storage; later edits are ignored. */
  allowedApps: Array<Omit<CuaApplicationGrant, 'id'> & {
    /** Unbranded digest at the profile configuration boundary; admitted by the Config schema. */
    id: string
  }>
  /** Absolute executable inside the signed macOS helper .app; omission prepares the package-owned application. */
  helperPath?: string
  /** Maximum time in milliseconds for native component preparation. */
  buildTimeoutMs: number
  /** Deadline for one native operation, including capture and AX traversal. */
  timeoutMs: number
  /** Maximum time to connect to or start the shared native helper. */
  connectTimeoutMs: number
  /** Screenshot deadline including time queued behind other native operations. */
  screenshotTimeoutMs: number
  /** Deadline for each individual Accessibility system call. */
  axTimeoutMs: number
  /** Maximum bytes retained for one helper response frame. */
  maxResponseBytes: number
  /** Maximum installed application matches returned for one discovery query. */
  maxAppMatches: number
  /** Maximum bytes preserved from the system clipboard during one paste. */
  maxClipboardBytes: number
  /** Maximum wait for clipboard data consumption after the Paste command returns. */
  pasteReadTimeoutMs: number
  /** Maximum UTF-8 bytes admitted for one helper request frame. */
  maxRequestBytes: number
  /** Duration in milliseconds of one same-window drag. */
  dragDurationMs: number
  /** Maximum explicitly requested mouse-button hold in milliseconds; zero allows immediate release only. */
  maxClickHoldMs: number
  /** Number of movement segments dispatched during a drag. */
  dragSteps: number
  /** Delay in milliseconds after each Unicode key-down or key-up event. */
  textEventIntervalMs: number
  /** Native connection cleanup, socket-write and launcher termination budget in milliseconds. */
  graceMs: number
  /** Maximum nodes admitted by a native accessibility snapshot. */
  maxElements: number
  /** Maximum depth traversed by a native accessibility snapshot. */
  maxDepth: number
}

/** Validate shared configuration for native providers. */
export const CuaConfig = Schema.object(CuaConfigFields) satisfies Schema<Record<string, unknown>, CuaConfig>


function executionAgent(execution: Readonly<ToolExecution>): Agent {
  if (!execution.agent) throw new Error('dsh-cua requires an agent-owned execution')
  return execution.agent
}

interface CuaExecution extends ToolExecution {
  agent: Agent
  nativeClient: NativeClient
  coordinates: CuaCoordinates
}


type ScreenshotValue = z.infer<typeof ScreenshotResult> & { attachment: { [K in keyof ImageAttachmentRef]: ImageAttachmentRef[K] } }

/** Native values stay available to programs; only metadata and the stored image enter model content. */
function renderResult(args: unknown, value: JsonValue): ContentBlock[] {
  if ((args as CuaOperation).method !== 'screenshot') return [{ type: 'text', text: JSON.stringify(value) }]
  const { data: _data, mimeType: _mimeType, attachment, ...metadata } = value as ScreenshotValue
  return [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', attachment }]
}

/** Resolve the exact calling model and attachment store before requesting a screenshot. */
async function screenshotStore(ctx: Context, execution: Readonly<CuaExecution>) {
  const attachments = ctx.get('attachments')
  if (!attachments) throw new Error('CUA screenshots require an attachment store')
  const agent = execution.agent
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider ?? agent.options.provider
  const model = routed?.model ?? agent.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) throw new Error('CUA screenshot model route could not be resolved')
  const info = await llm.resolveModelInfo(provider, model, execution.signal)
  execution.signal.throwIfAborted()
  if (!info.inputModalities?.includes('image')) throw new Error(`CUA screenshots require model "${model}" to declare image input`)
  return { attachments, target: (image: ImageAttachmentRef) => llm.imageRequestTarget(provider, model, image) }
}

/** Prepared platform executable, transport, platform-specific instructions and startup capabilities. */
export interface CuaBackend {
  helperPath: string
  createChannel: NativeChannelFactory
  guidance: string
  capabilities: CuaStartupCapabilities
  /** Dispatch a directional key through the provider's execution-scoped input owner, after application authorization. */
  sendKeyEvent?: (client: NativeClient, params: Record<string, JsonValue>,
    execution: Readonly<ToolExecution>) => Promise<JsonValue>
  /**
   * Build native permission parameters for the selected action and Client language.
   * @param method Native permission action.
   * @param permission System privilege selected by the user.
   * @param locale Current Client language.
   * @returns Parameters accepted by the provider's native implementation.
   */
  permissionParameters: (method: 'requestPermission' | 'openPermissionSettings', permission: CuaSystemPermission, locale: string) => Record<string, JsonValue>
}

/**
 * Install authorized CUA calls and Agent-owned native connections.
 * @param ctx - Provider context with computer-use, subprocess, tools, prompt, and Agent services.
 * @param config - Validated resource limits and live application grants.
 * @param backend - Platform-owned executable, connection factory, and instructions.
 */
export function installCua(ctx: Context, config: CuaConfig, backend: CuaBackend): void {
  const { helperPath } = backend
  const systemPointer = backend.capabilities.systemPointer === true
  const mouseControl = systemPointer ? new MouseControl(ctx, config.requireSystemPointerApproval) : undefined
  const requestSchema = systemPointer ? SystemPointerRequest : Request
  const instructions = systemPointer ? withSystemPointerGuidance(backend.guidance) : backend.guidance
  const guidance = `${instructions}\n\nMaximum click holdMs: ${config.maxClickHoldMs} ms.`
  const native: NativeClientConfig = {
    helperPath, cwd: process.cwd(), timeoutMs: config.timeoutMs, axTimeoutMs: config.axTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs, screenshotTimeoutMs: config.screenshotTimeoutMs,
    maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxResponseBytes, graceMs: config.graceMs,
    textEventIntervalMs: config.textEventIntervalMs, maxClickHoldMs: config.maxClickHoldMs,
  }
  const access = installCuaAccess(ctx, {
    native, createChannel: backend.createChannel,
    permissionParameters: backend.permissionParameters,
    store: new CuaPermissionStore(ctx, config.allowedApps.map(grant => ({ ...grant, id: grant.id as CuaApplicationId })), config.timeoutMs),
  })
  const clients = new Map<Agent, NativeClient>()
  const lifetime = new AbortController()
  const pending = new Map<Promise<unknown>, Agent>()
  const ownerCleanups = new Map<Agent, {
    close: () => Promise<void>
    release: () => Promise<void>
    signal: AbortSignal
    coordinates: CuaCoordinates
  }>()
  const closedOwners = new WeakSet<Agent>()
  function ownerFor(agent: Agent) {
    if (closedOwners.has(agent) || ctx.agents.get(agent.id) !== agent) throw new Error('dsh-cua agent has been disposed')
    const existing = ownerCleanups.get(agent)
    if (existing) return existing
    const controller = new AbortController()
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => {
      closedOwners.add(agent)
      controller.abort()
      return closing ??= Promise.resolve().then(async () => {
        try {
          await clients.get(agent)?.dispose()
        } finally {
          await Promise.allSettled([...pending].filter(([, owner]) => owner === agent).map(([task]) => task))
          clients.delete(agent)
          access.forget(agent)
          ownerCleanups.delete(agent)
        }
      })
    }
    const release = agent.ctx.effect(() => close, 'dsh-cua.agent')
    const owner = { close, release, signal: controller.signal, coordinates: new CuaCoordinates() }
    ownerCleanups.set(agent, owner)
    return owner
  }
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('dsh-cua'))
    yield async () => {
      lifetime.abort()
      const permissions = Promise.allSettled([access.dispose()])
      await Promise.allSettled(pending.keys())
      const owners = [...ownerCleanups.values()]
      const results = await Promise.allSettled(owners.map(owner => owner.close()))
      const releases = await Promise.allSettled(owners.map(owner => owner.release()))
      const errors: unknown[] = []
      for (const result of [...await permissions, ...results, ...releases]) if (result.status === 'rejected') errors.push(result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'dsh-cua helper cleanup failed')
    }
    const callNative = async (request: CuaOperation, execution: Readonly<CuaExecution>, useSystemPointer?: boolean) => {
      const { method, params: parsedParams } = request
      const params = execution.coordinates.parameters(request)
      const agent = execution.agent
      const signal = execution.signal
      signal.throwIfAborted()
      const client = execution.nativeClient
      if (useSystemPointer !== undefined) params.useSystemPointer = useSystemPointer
      if (method === 'sendKeyEvent' && backend.sendKeyEvent) return backend.sendKeyEvent(client, params, execution)
      const nativeParams = method === 'findApps'
        ? { ...params, maxAppMatches: config.maxAppMatches }
        : method === 'paste'
          ? { ...params, maxClipboardBytes: config.maxClipboardBytes, pasteReadTimeoutMs: config.pasteReadTimeoutMs,
            maxElements: config.maxElements, maxDepth: config.maxDepth }
          : method === 'getState'
            ? { ...params, maxElements: config.maxElements, maxDepth: config.maxDepth }
            : method === 'drag' ? { ...params, durationMs: config.dragDurationMs, steps: config.dragSteps }
              : params
      const requestNative = () => client.request(method, nativeParams, signal, execution.callId)
      if (method === 'screenshot') {
        const { attachments, target } = await screenshotStore(ctx, execution)
        const screenshot = NativeScreenshotResult.parse(await requestNative())
        if (screenshot.windowId !== parsedParams.windowId) throw new NativeError('NATIVE_PROTOCOL', 'Native screenshot belongs to another window')
        signal.throwIfAborted()
        const stage = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
          try { return await operation() } catch (error) {
            signal.throwIfAborted()
            const code = attachments.isAttachmentError(error) ? error.code : 'SCREENSHOT_IMAGE_FAILED'
            const summary = error instanceof Error ? error.message.slice(0, 300) : 'Image processing failed'
            const cause = error instanceof Error && error.cause instanceof Error ? ` Cause: ${error.cause.message.slice(0, 300)}` : ''
            throw new NativeError(code, `Screenshot ${name} failed for window ${screenshot.windowId} `
              + `(${screenshot.pixelWidth}x${screenshot.pixelHeight}, ${screenshot.data.length} encoded bytes): `
              + `${summary}${cause} No screenshot was delivered; capture fresh state before using image coordinates.`, { cause: error })
          }
        }
        const refs = await stage('image admission', () => admitEncodedImages(attachments, [{ data: screenshot.data, mediaType: screenshot.mimeType }]))
        signal.throwIfAborted()
        const attachment = refs[0] as ImageAttachmentRef
        const original = attachment.originalDimensions ?? attachment
        if (original.width !== screenshot.pixelWidth || original.height !== screenshot.pixelHeight) {
          throw new NativeError('NATIVE_PROTOCOL', 'Native screenshot dimensions disagree with its decoded image')
        }
        const image = await stage('model image preparation', () => attachments.readImageRequest(attachment, target(attachment), signal))
        signal.throwIfAborted()
        execution.coordinates.screenshot(parsedParams.appHandle as CuaAppHandle, screenshot.windowId, screenshot.bounds, image)
        return { ...screenshot, mimeType: image.mediaType, data: Buffer.from(image.data).toString('base64'),
          pixelWidth: image.width, pixelHeight: image.height, coordinateSpace: 'screenshot-pixels', attachment }
      }
      const result = method === 'paste'
        ? await withFileLock(join(tmpdir(), 'dsh-cua-system-clipboard'), requestNative, { waitMs: config.timeoutMs, signal })
        : await requestNative()
      if (method === 'getApp') {
        const prepared = AppResult.parse(result)
        const { authorization, applicationIcon } = z.object({ authorization: ApplicationAuthorizationResult,
          applicationIcon: ApplicationIcon.optional(),
        }).parse(result)
        await access.select(agent, client, prepared.appHandle, authorization, signal, applicationIcon)
        signal.throwIfAborted()
        const selected = prepared.running
          ? prepared
          : AppResult.parse(await access.run(client, prepared.appHandle, signal,
            signal => client.request('launchApp', { appHandle: prepared.appHandle }, signal, execution.callId)))
        if (selected.appHandle !== prepared.appHandle) throw new NativeError('NATIVE_PROTOCOL', 'Launched application has another handle')
        return selected
      }
      signal.throwIfAborted()
      if (method === 'getCapabilities') {
        const runtime = z.record(z.string(), z.json()).parse(result)
        const capabilities = backend.capabilities
        return {
          ...runtime,
          platform: capabilities.platform, systemPointer,
          methods: [...capabilities.methods],
          appLevelAccessibility: capabilities.appLevelAccessibility,
          keyboard: [...capabilities.keyboard],
          browser: capabilities.browser,
          coordinateSpace: capabilities.coordinateSpace,
        }
      }
      if (method === 'getState') {
        const state = StateResult.parse(result)
        if (state.appHandle !== parsedParams.appHandle || state.windowId !== (parsedParams.windowId ?? null)) {
          throw new NativeError('NATIVE_PROTOCOL', 'Native observation belongs to another application or window')
        }
        execution.coordinates.observe(state.appHandle, state.windows, state.windowId ?? undefined)
        return state
      }
      if (method === 'listWindows') execution.coordinates.observe(parsedParams.appHandle as CuaAppHandle, WindowsResult.parse(result))
      return result
    }
    const tool: ToolDefinition = {
      name: 'cua',
      description: 'Inspect desktop access, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state.',
      parameters: { ...z.record(z.string(), z.json()).parse(z.toJSONSchema(requestSchema)), type: 'object' },
      output: { schema: {}, render: renderResult },
      async execute(args, execution) {
        const request = requestSchema.parse(args)
        const agent = executionAgent(execution)
        execution.signal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        const owner = ownerFor(agent)
        const signal = AbortSignal.any([execution.signal, lifetime.signal, owner.signal])
        signal.throwIfAborted()
        const operation = (async () => {
          const previous = clients.get(agent)
          if (previous?.disposed) {
            try { await previous.dispose() } catch (error) {
              // Retire the settled failed connection even when native cleanup could
              // not be acknowledged. This call reports failure; a later selection
              // may connect afresh, but must never reuse its handles or coordinates.
              if (clients.get(agent) === previous) {
                clients.delete(agent)
                access.forget(agent)
                owner.coordinates = new CuaCoordinates()
              }
              throw error
            }
          }
          signal.throwIfAborted()
          let client = clients.get(agent)
          if ('appHandle' in request.params && !client) {
            throw new NativeError('APP_ACCESS_REQUIRED', 'Select the application with getApp before reading or controlling it')
          }
          if (!client || (client.disposed && !('appHandle' in request.params))) {
            client = new NativeClient(ctx, native, backend.createChannel, (message) => { ctx.logger.debug(message) })
            clients.set(agent, client)
            owner.coordinates = new CuaCoordinates()
          }
          const nativeClient = client
          const route = request.method === 'mouseMove'
            ? mouseControl?.resolve(agent, 'useSystemPointer' in request.params && request.params.useSystemPointer === true)
            : undefined
          if (route?.prepare) owner.coordinates.parameters(request)
          const dispatch = async (signal: AbortSignal) => {
            const scoped = { ...execution, agent, signal, nativeClient, coordinates: owner.coordinates }
            const result = await callNative(request, scoped, route?.useSystemPointer)
            signal.throwIfAborted()
            return result
          }
          return 'appHandle' in request.params
            ? access.run(nativeClient, request.params.appHandle as CuaAppHandle, signal, dispatch, route?.prepare)
            : dispatch(signal)
        })()
        pending.set(operation, agent)
        try {
          return await operation
        } finally {
          pending.delete(operation)
        }
      },
    }
    const prompt: PromptSection = {
      name: 'computer-use:dsh-cua', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: () => {
        const runtime = ctx.get('ptcRuntime')
        return !runtime?.retainsState ? guidance : `${guidance}

Persistent PTC initialization:

\`\`\`ts
var { connectCua } = await import(${JSON.stringify(new URL('../lib/bridge.js', import.meta.url).href)});
var cua = connectCua(() => tools.cua, text => console.log(text));
\`\`\``
      },
    }
    const register = (scope: Context): void => {
      scope.tools.register(tool)
      scope.systemPrompt.section(prompt)
    }
    if (config.agentPreset === false) register(ctx)
    else {
      const consumer = ctx.inject(['agentPresets'], async (presetCtx) => {
        const scopes = new Map<Agent, Scope>()
        const sync = async (agent: Agent): Promise<void> => {
          const previous = scopes.get(agent)
          if (presetCtx.agentPresets.composedPreset(agent.ctx) !== config.agentPreset) {
            scopes.delete(agent)
            await previous?.dispose()
            return
          }
          if (previous !== undefined) return
          const scope = createScope(agent.ctx, agent)
          scopes.set(agent, scope)
          scope.ctx.effect(() => () => {
            if (scopes.get(agent) === scope) scopes.delete(agent)
          }, 'cua.agent-tools')
          register(scope.ctx)
        }
        presetCtx.effect(() => async () => { await Promise.all([...scopes.values()].map(scope => scope.dispose())) }, 'cua.agent-tools')
        presetCtx.on('agent/created', async ({ agent }) => { await sync(agent) })
        presetCtx.on('agent-preset/selected', (id) => {
          const agent = presetCtx.agents.get(id)
          if (agent !== undefined) void sync(agent).catch((error: unknown) => { presetCtx.logger.warn(`CUA tool scope update failed: ${String(error)}`) })
        })
        await Promise.all(presetCtx.agents.list().map(sync))
      })
      yield () => consumer.dispose()
    }
  }, 'dsh-cua.runtime')
}

/** Host marker for the optional Client contribution; platform providers install native execution separately. */
export function apply(): void {}
