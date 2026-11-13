/** Shared CUA tool execution, application consent, and object-runtime integration. */
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/types'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
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
import { ApplicationIcon, AppResult, NativeScreenshotResult, Request, SystemPointerRequest, ScreenshotResult } from './protocol.ts'
import { CuaConfigFields, type CuaScreenshotTargetConfig, type CuaStandaloneRunCodeConfig } from './config.ts'
import { fixedScreenshotTarget, installCuaTools } from './tool-registration.ts'
import { CuaCoordinates } from './coordinates.ts'
import { observeNativeWindows } from './native-observation.ts'
import { ToolArgsError, ToolContextUnavailableError, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'

export { CuaAccess } from './access.ts'
export type { CuaStartupCapabilities } from './types.ts'
export type { CuaPrograms } from './tool-registration.ts'

/** Native executable and per-operation resource bounds. */
export interface CuaConfig {
  /** Ask once per live Session before explicitly requested system-pointer moves or drags. */
  requireSystemPointerApproval: boolean
  /**
   * Preset receiving raw cua; every other Agent, with or without a preset, receives cua_run_code while its
   * program services are available. False registers raw cua globally.
   */
  agentPreset: string | false
  /** Dedicated persistent program limits, independent of the profile's PTC runtime. */
  standaloneRunCode: CuaStandaloneRunCodeConfig
  /**
   * Fixed request-image target for screenshots. Omission resolves the target from the Agent's model
   * route and refuses capture when that route declares no image input.
   */
  screenshotTarget?: CuaScreenshotTargetConfig | undefined
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
  /** Default node limit when an accessibility read omits maxElements. */
  maxElements: number
  /** Default depth limit when an accessibility read omits maxDepth. */
  maxDepth: number
}

/** Validate shared configuration for native providers. */
export const CuaConfig = Schema.object(CuaConfigFields) satisfies Schema<Record<string, unknown>, CuaConfig>


function executionAgent(execution: Readonly<ToolExecution>): Agent {
  if (!execution.agent) throw new ToolContextUnavailableError('dsh-cua requires an agent-owned execution')
  return execution.agent
}

/**
 * Describe one request issue for the model. A union that no accepted form matches lists each form's own
 * issues, so the model learns which field to add or remove, such as a missing `params.y`.
 * @param issue - one issue from parsing the request.
 * @param base - path of the value the issue belongs to.
 * @returns a single-line violation naming the field and the reason.
 */
function requestViolation(issue: z.core.$ZodIssue, base: readonly PropertyKey[] = []): string {
  const path = [...base, ...issue.path]
  const field = path.length > 0 ? path.map(String).join('.') : 'arguments'
  if (issue.code !== 'invalid_union' || issue.errors.length === 0) return `${field}: ${issue.message}`
  const forms = issue.errors.map(form => `(${form.map(nested => requestViolation(nested, path)).join('; ')})`)
  return `${field}: matches none of the accepted forms: ${forms.join(' or ')}`
}

/** Parse the tool request; refinements the parameter schema cannot express fail as argument errors. */
function parseRequest<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new ToolArgsError(parsed.error.issues.map(issue => requestViolation(issue)))
  return parsed.data
}

/** Native cancellation after the caller cancelled keeps its diagnostic; the tool registry records it as `ABORTED`. */
function callerCancelled(error: NativeError): Error {
  const cancelled = new Error(error.message, { cause: error })
  cancelled.name = 'AbortError'
  return cancelled
}

interface CuaExecution extends ToolExecution {
  agent: Agent
  nativeClient: NativeClient
  coordinates: CuaCoordinates
}


const nativeDiscoveryRows = z.array(z.record(z.string(), z.json()))

type ScreenshotValue = z.infer<typeof ScreenshotResult> & { attachment: { [K in keyof ImageAttachmentRef]: ImageAttachmentRef[K] } }

/** Native values stay available to programs; only metadata and the stored image enter model content. */
function renderResult(args: unknown, value: JsonValue): ContentBlock[] {
  if ((args as CuaOperation).method !== 'screenshot') return [{ type: 'text', text: JSON.stringify(value) }]
  const { data: _data, mimeType: _mimeType, attachment, ...metadata } = value as ScreenshotValue
  return [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', attachment }]
}

/** Resolve the attachment store and the request-image target before requesting a screenshot. */
async function screenshotStore(ctx: Context, execution: Readonly<CuaExecution>, configured: CuaScreenshotTargetConfig | undefined) {
  const attachments = ctx.get('attachments')
  if (!attachments) throw new ToolContextUnavailableError('CUA screenshots require an attachment store')
  if (configured !== undefined) {
    return { attachments, target: (image: ImageAttachmentRef): ImageRequestTarget => fixedScreenshotTarget(configured, image) }
  }
  const agent = execution.agent
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider ?? agent.options.provider
  const model = routed?.model ?? agent.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new ToolContextUnavailableError('CUA screenshot model route could not be resolved')
  }
  const info = await llm.resolveModelInfo(provider, model, execution.signal)
  execution.signal.throwIfAborted()
  if (!info.inputModalities?.includes('image')) {
    throw new NativeError('MODEL_DOES_NOT_SUPPORT_IMAGES', `CUA screenshots require model "${model}" to declare image input`)
  }
  return { attachments, target: (image: ImageAttachmentRef) => llm.imageRequestTarget(provider, model, image) }
}

/** Prepared platform executable, transport, platform-specific instructions and startup capabilities. */
export interface CuaBackend {
  helperPath: string
  createChannel: NativeChannelFactory
  /**
   * Select platform operation instructions for the exposed tool form.
   * @param kind Raw cua calls or standalone cua_run_code programs.
   * @returns Instructions before shared capability guidance and configured limits are added.
   */
  getGuidance(kind: 'raw' | 'standalone'): string
  capabilities: CuaStartupCapabilities
  /** Preserve discovery PIDs when getApp accepts a decimal PID as an exact process selector. */
  acceptsPidSelector?: boolean
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
  const formatGuidance = (text: string): string => {
    const instructions = systemPointer ? withSystemPointerGuidance(text) : text
    return `${instructions}\n\nAX read defaults: maxElements=${config.maxElements}, maxDepth=${config.maxDepth}.\n\nMaximum click holdMs: ${config.maxClickHoldMs} ms.`
  }
  const guidance = formatGuidance(backend.getGuidance('raw'))
  const programGuidance = formatGuidance(backend.getGuidance('standalone'))
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
    if (closedOwners.has(agent) || ctx.agents.get(agent.id) !== agent) throw new ToolContextUnavailableError('dsh-cua agent has been disposed')
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
    yield ctx.computerUse.register(brandString<ComputerUseProviderName>('dsh-cua'))
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
      // Released macOS helpers accept an explicit false for mouseMove but reject the new drag field.
      if (method === 'drag' && !useSystemPointer) delete params.useSystemPointer
      else if (useSystemPointer !== undefined) params.useSystemPointer = useSystemPointer
      if (method === 'sendKeyEvent' && backend.sendKeyEvent) return backend.sendKeyEvent(client, params, execution)
      const nativeParams = method === 'findApps'
        ? { ...params, maxAppMatches: config.maxAppMatches }
        : method === 'paste'
          ? { ...params, maxClipboardBytes: config.maxClipboardBytes, pasteReadTimeoutMs: config.pasteReadTimeoutMs,
            maxElements: config.maxElements, maxDepth: config.maxDepth }
          : method === 'getState'
            ? { maxElements: config.maxElements, maxDepth: config.maxDepth, ...params }
            : method === 'drag' ? { ...params, durationMs: config.dragDurationMs, steps: config.dragSteps }
              : params
      const requestNative = () => client.request(method, nativeParams, signal, execution.callId)
      if (method === 'screenshot') {
        const { attachments, target } = await screenshotStore(ctx, execution, config.screenshotTarget)
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
        let attachment = refs[0] as ImageAttachmentRef
        const original = attachment.originalDimensions ?? attachment
        if (original.width !== screenshot.pixelWidth || original.height !== screenshot.pixelHeight) {
          throw new NativeError('NATIVE_PROTOCOL', 'Native screenshot dimensions disagree with its decoded image')
        }
        const image = await stage('model image preparation', () => attachments.readImageRequest(attachment, target(attachment), signal))
        signal.throwIfAborted()
        if (image.width !== attachment.width || image.height !== attachment.height) {
          attachment = await stage('image storage', () => attachments.saveImage({ data: image.data, mediaType: image.mediaType }))
          signal.throwIfAborted()
        }
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
      if ((method === 'listApps' || method === 'findApps') && !backend.acceptsPidSelector) {
        return nativeDiscoveryRows.parse(result).map(({ pid: _pid, ...record }) => record)
      }
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
      if (request.method === 'getState' || request.method === 'listWindows') {
        return observeNativeWindows(request, result, execution.coordinates)
      }
      return result
    }
    const tool: ToolDefinition = {
      name: 'cua',
      description: 'Inspect desktop access, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state.',
      parameters: { ...z.record(z.string(), z.json()).parse(z.toJSONSchema(requestSchema)), type: 'object' },
      output: { schema: {}, render: renderResult },
      async execute(args, execution) {
        const request = parseRequest(requestSchema, args)
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
          const route = request.method === 'mouseMove' || request.method === 'drag'
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
        } catch (error) {
          if (execution.signal.aborted && error instanceof NativeError && error.code === 'NATIVE_CANCELLED') throw callerCancelled(error)
          throw error
        } finally {
          pending.delete(operation)
        }
      },
    }
    yield installCuaTools(ctx, config, tool, guidance, programGuidance)
  }, 'dsh-cua.runtime')
}

/** Host marker for the optional Client contribution; platform providers install native execution separately. */
export function apply(): void {}
