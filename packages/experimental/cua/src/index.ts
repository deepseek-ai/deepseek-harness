/** Shared CUA tool execution, application consent, and object-runtime integration. */
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { NativeClient, NativeError, type NativeClientConfig, type NativeChannelFactory } from './native-client.ts'
import { ApplicationAuthorizationResult, ApplicationAccess } from './application-access.ts'
import type { CuaApplicationGrant, CuaApplicationId } from './application-types.ts'
import type { CuaAppHandle, CuaOperation } from './types.ts'
import { AppResult, NativeScreenshotResult, Request, ScreenshotResult, StateResult, WindowsResult } from './protocol.ts'
import { CuaCoordinates } from './coordinates.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'


/** Native executable and per-operation resource bounds. */
export interface CuaConfig {
  /** Signed applications explicitly approved for future tasks in this profile. */
  allowedApps: Volatile<Array<Omit<CuaApplicationGrant, 'id'> & {
    /** Unbranded digest at the profile configuration boundary; admitted by the Config schema. */
    id: string
  }>>
  /** Absolute native helper override; omission prepares the package-owned executable. */
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

/** Validated host configuration; no driver is downloaded at runtime. */
export const CuaConfig = Schema.object({
  allowedApps: Schema.array(Schema.object({
    id: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
    name: Schema.string().required(), executablePath: Schema.string().min(1).required(),
  })).default([]).volatile(),
  helperPath: Schema.string(),
  buildTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(300_000),
  timeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(30_000),
  connectTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5000),
  screenshotTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5000),
  axTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxAppMatches: Schema.number().step(1).min(1).max(1000).default(20),
  maxClipboardBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
  pasteReadTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(1000),
  maxRequestBytes: Schema.number().step(1).min(1024).default(1024 * 1024),
  dragDurationMs: Schema.number().step(1).min(1).max(5000).default(400),
  dragSteps: Schema.number().step(1).min(1).max(240).default(20),
  maxResponseBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
  textEventIntervalMs: Schema.number().min(0).max(1000).default(0.25),
  graceMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxElements: Schema.number().step(1).min(1).max(10000).default(2000),
  maxDepth: Schema.number().step(1).min(1).max(100).default(25),
}) satisfies Schema<Record<string, unknown>, CuaConfig>


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

/** Prepared platform executable, transport, and platform-specific operating instructions. */
export interface CuaBackend {
  helperPath: string
  createChannel: NativeChannelFactory
  guidance: string
  description: string
}

/**
 * Install authorized CUA calls and Agent-owned native connections.
 * @param ctx - Provider context with computer-use, subprocess, tools, prompt, and Agent services.
 * @param config - Validated resource limits and live application grants.
 * @param backend - Platform-owned executable, connection factory, and instructions.
 */
export function installCua(ctx: Context, config: CuaConfig, backend: CuaBackend): void {
  const { helperPath } = backend
  const native: NativeClientConfig = {
    helperPath, cwd: process.cwd(), timeoutMs: config.timeoutMs, axTimeoutMs: config.axTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs, screenshotTimeoutMs: config.screenshotTimeoutMs,
    maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxResponseBytes, graceMs: config.graceMs,
    textEventIntervalMs: config.textEventIntervalMs,
  }
  const entryId = ctx.fiber.entry?.options.id
  ctx.inject(['settings'], scope => scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)))
  const access = new ApplicationAccess(ctx, {
    grants: () => config.allowedApps.get().map(grant => ({ ...grant, id: grant.id as CuaApplicationId })),
    get save() {
      const settings = ctx.get('settings')
      if (entryId === undefined || settings === undefined) return undefined
      const descriptor = settings.describe().find(entry => entry.ns === entryId)
      if (!descriptor) return undefined
      return async (grants: readonly CuaApplicationGrant[]) => {
        await settings.mutate(entryId, [{ op: 'set', path: ['allowedApps'], value: grants }], descriptor.revision)
      }
    },
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
    const callNative = async (request: CuaOperation, execution: Readonly<CuaExecution>) => {
      const { method, params: parsedParams } = request
      const params = execution.coordinates.parameters(request)
      const agent = execution.agent
      const signal = execution.signal
      signal.throwIfAborted()
      const client = execution.nativeClient
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
        signal.throwIfAborted()
        const refs = await admitEncodedImages(attachments, [{ data: screenshot.data, mediaType: screenshot.mimeType }])
        signal.throwIfAborted()
        const attachment = refs[0] as ImageAttachmentRef
        const original = attachment.originalDimensions ?? attachment
        if (original.width !== screenshot.pixelWidth || original.height !== screenshot.pixelHeight) {
          throw new NativeError('NATIVE_PROTOCOL', 'Native screenshot dimensions disagree with its decoded image')
        }
        const image = await attachments.readImageRequest(attachment, target(attachment), signal)
        signal.throwIfAborted()
        execution.coordinates.screenshot(parsedParams.appHandle as CuaAppHandle, screenshot.windowId, screenshot.bounds, image)
        return { ...screenshot, mimeType: image.mediaType, data: Buffer.from(image.data).toString('base64'),
          pixelWidth: image.width, pixelHeight: image.height, coordinateSpace: 'screenshot-pixels', attachment }
      }
      const result = method === 'paste'
        ? await withFileLock(join(tmpdir(), 'dsh-cua-system-clipboard'), requestNative, { waitMs: config.timeoutMs, signal })
        : await requestNative()
      if (method === 'getApp') {
        const prepared = AppResult.extend({ pid: AppResult.shape.pid.nullable() }).parse(result)
        const { authorization } = z.object({ authorization: ApplicationAuthorizationResult }).parse(result)
        await access.select(agent, client, prepared.appHandle, authorization, signal)
        signal.throwIfAborted()
        const selected = prepared.pid === null
          ? AppResult.parse(await access.run(client, prepared.appHandle, signal,
            signal => client.request('launchApp', { appHandle: prepared.appHandle }, signal, execution.callId)))
          : AppResult.parse(prepared)
        if (selected.appHandle !== prepared.appHandle) throw new NativeError('NATIVE_PROTOCOL', 'Launched application has another handle')
        return selected
      }
      signal.throwIfAborted()
      if (method === 'getCapabilities') return { ...z.record(z.string(), z.json()).parse(result), coordinateSpace: 'screenshot-pixels' }
      if (method === 'getState') {
        const state = StateResult.parse(result)
        execution.coordinates.observe(state.appHandle, state.windows, state.windowId ?? undefined)
        return state
      }
      if (method === 'listWindows') execution.coordinates.observe(parsedParams.appHandle as CuaAppHandle, WindowsResult.parse(result))
      return result
    }
    yield ctx.tools.register({
      name: 'cua', description: backend.description,
      parameters: { ...z.record(z.string(), z.json()).parse(z.toJSONSchema(Request)), type: 'object' },
      output: { schema: {}, render: renderResult },
      async execute(args, execution) {
        const request = Request.parse(args)
        const agent = executionAgent(execution)
        execution.signal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        const owner = ownerFor(agent)
        const signal = AbortSignal.any([execution.signal, lifetime.signal, owner.signal])
        signal.throwIfAborted()
        const operation = (async () => {
          const previous = clients.get(agent)
          if (previous?.disposed) await previous.dispose()
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
          const dispatch = async (signal: AbortSignal) => {
            const scoped = { ...execution, agent, signal, nativeClient, coordinates: owner.coordinates }
            const result = await callNative(request, scoped)
            signal.throwIfAborted()
            return result
          }
          return 'appHandle' in request.params
            ? access.run(nativeClient, request.params.appHandle as CuaAppHandle, signal, dispatch)
            : dispatch(signal)
        })()
        pending.set(operation, agent)
        try {
          return await operation
        } finally {
          pending.delete(operation)
        }
      },
    })
    yield ctx.systemPrompt.section({
      name: 'computer-use:dsh-cua', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: () => ctx.get('ptcRuntime')?.programFormat !== 'repl' ? backend.guidance : `${backend.guidance}

Persistent PTC initialization:
var { connectCua } = await import(${JSON.stringify(new URL('../lib/bridge.js', import.meta.url).href)});
var cua = connectCua(() => tools.cua, text => console.log(text));`,
    })
  }, 'dsh-cua.runtime')
}
