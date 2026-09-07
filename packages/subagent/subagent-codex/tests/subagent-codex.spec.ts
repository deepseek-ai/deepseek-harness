import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as codex from '../src/index.ts'
import {
  CODEX_PERMISSION_MODES,
  DEFAULT_CODEX_PERMISSION_MODE,
  codexAppServerArgv,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeCodexChild,
  startCodexRun,
  textTask,
  type CodexRunSpec,
} from '../src/run.ts'
import { CodexAppServerWire } from '../src/wire.ts'

const { hostStderrWrite } = vi.hoisted(() => ({
  hostStderrWrite: {
    capture: false,
    failNext: false,
    chunks: [] as Buffer[],
  },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync(
      fd: number,
      value: string | Uint8Array,
    ): void {
      if (fd === 2 && hostStderrWrite.capture) {
        if (hostStderrWrite.failNext) {
          hostStderrWrite.failNext = false
          throw Object.assign(new Error('host stderr broke'), { code: 'EIO' })
        }
        const bytes = typeof value === 'string'
          ? Buffer.from(value)
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        hostStderrWrite.chunks.push(bytes)
        return
      }
      actual.writeFileSync(fd, value)
    },
  }
})

type JsonObject = Record<string, unknown>

const CODEX_VERSION = '0.149.1'
const CODEX_PLATFORM_PACKAGES = [
  '@openai/codex-darwin-arm64',
  '@openai/codex-darwin-x64',
  '@openai/codex-linux-arm64',
  '@openai/codex-linux-x64',
  '@openai/codex-win32-arm64',
  '@openai/codex-win32-x64',
] as const

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as Agent

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'do the task' }],
  signal = new AbortController().signal,
) {
  return { prompt, parent: fakeParent, signal }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

class ProtocolPeer {
  private buffer = ''
  private readonly frames: JsonObject[] = []
  private readonly wakeups = new Set<() => void>()

  constructor(
    input: PassThrough,
    private readonly output: PassThrough,
  ) {
    input.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString()
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim().length > 0) this.frames.push(JSON.parse(line) as JsonObject)
      }
      for (const wake of this.wakeups) wake()
      this.wakeups.clear()
    })
  }

  async next(predicate: (frame: JsonObject) => boolean): Promise<JsonObject> {
    for (;;) {
      const index = this.frames.findIndex(predicate)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      await new Promise<void>((resolve) => { this.wakeups.add(resolve) })
    }
  }

  nextMethod(method: string): Promise<JsonObject> {
    return this.next(frame => frame.method === method)
  }

  nextResponse(id: unknown): Promise<JsonObject> {
    return this.next(frame => frame.id === id && frame.method === undefined)
  }

  send(...frames: readonly JsonObject[]): void {
    this.output.write(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
  }

  respond(requestFrame: JsonObject, result: unknown): void {
    this.send({ id: requestFrame.id, result })
  }
}

interface FakeChildOptions {
  readonly exitOnTerminate?: boolean
  readonly doneError?: Error
  readonly waitForExitError?: Error
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly peer: ProtocolPeer
  readonly fromChild: PassThrough
  readonly toChild: PassThrough
  readonly stderr: PassThrough
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly fail: (error: Error) => void
  readonly setStderr: (text: string) => void
  readonly terminate: () => void
  readonly waitForExit: (signal?: AbortSignal) => Promise<boolean>
}

function fakeChild(options: FakeChildOptions = {}): FakeChild {
  const fromChild = new PassThrough()
  const toChild = new PassThrough()
  const stderr = new PassThrough()
  const peer = new ProtocolPeer(toChild, fromChild)
  let exited = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const settle = (
    outcome: SubprocessOutcome = { exitCode: 0, signal: null },
  ): void => {
    if (exited) return
    exited = true
    resolveDone(outcome)
  }
  const fail = (error: Error): void => {
    if (exited) return
    exited = true
    rejectDone(error)
  }
  if (options.doneError !== undefined) fail(options.doneError)
  const terminate = vi.fn(() => {
    if (options.exitOnTerminate !== false) settle()
  })
  const waitForExit = vi.fn(async (signal?: AbortSignal) => {
    if (options.waitForExitError !== undefined) {
      throw options.waitForExitError
    }
    if (exited) return true
    if (signal === undefined) {
      await done.catch(() => {})
      return true
    }
    return await new Promise<boolean>((resolve) => {
      const onAbort = (): void => { resolve(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void done.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        },
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        },
      )
    })
  })
  const handle: SubprocessHandle = {
    stdin: toChild,
    stdout: fromChild,
    stderr,
    collected: {},
    done,
    terminate,
    waitForExit,
  }
  return {
    handle,
    peer,
    fromChild,
    toChild,
    stderr,
    settle,
    fail,
    setStderr: (text: string): void => { stderr.write(text) },
    terminate,
    waitForExit,
  }
}

function defaultWire(child: FakeChild): CodexAppServerWire {
  return new CodexAppServerWire(
    child.handle.stdout!,
    child.handle.stdin!,
    DEFAULT_CODEX_PERMISSION_MODE,
  )
}

function runSpec(
  child: FakeChild,
  overrides: Partial<CodexRunSpec> = {},
): CodexRunSpec {
  return {
    cwd: process.cwd(),
    permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
    env: {},
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: () => child.handle,
    ...overrides,
  }
}

async function initializeWire(): Promise<{
  readonly child: FakeChild
  readonly wire: CodexAppServerWire
}> {
  const child = fakeChild()
  const wire = defaultWire(child)
  wire.start()
  const initializing = wire.initialize(new AbortController().signal)
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
  await initializing
  expect(await child.peer.nextMethod('initialized')).toEqual({
    jsonrpc: '2.0',
    method: 'initialized',
  })
  const starting = wire.startThread(process.cwd(), new AbortController().signal)
  const threadStart = await child.peer.nextMethod('thread/start')
  child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
  await starting
  return { child, wire }
}

async function publishRun(
  child = fakeChild(),
  signal = new AbortController().signal,
  specOverrides: Partial<CodexRunSpec> = {},
) {
  const starting = startCodexRun(request(undefined, signal), runSpec(child, specOverrides))
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
  await child.peer.nextMethod('initialized')
  const threadStart = await child.peer.nextMethod('thread/start')
  child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
  const run = await starting
  const turnStart = await child.peer.nextMethod('turn/start')
  return { child, run, turnStart }
}

function agentMessage(
  text: unknown,
  phase: unknown,
  turnId = 'turn-1',
  threadId = 'thread-1',
): JsonObject {
  return {
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', text, phase },
    },
  }
}

function turnCompleted(
  status: unknown,
  turnId = 'turn-1',
  threadId = 'thread-1',
  error: unknown = null,
): JsonObject {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status, error },
    },
  }
}

function expectedFailureDiagnostic(
  stage: 'initialize' | 'thread-start' | 'turn-start' | 'turn' | 'process' | 'teardown',
  category: string,
  options: {
    readonly httpStatus?: number
    readonly outcome?: Partial<SubprocessOutcome>
  } = {},
): string {
  const fields = [
    'product: Codex',
    `stage: ${stage}`,
    `category: ${category}`,
  ]
  if (options.httpStatus !== undefined) {
    fields.push(`HTTP status: ${options.httpStatus}`)
  }
  if (
    options.outcome?.exitCode !== null
    && options.outcome?.exitCode !== undefined
  ) {
    fields.push(`exit code: ${options.outcome.exitCode}`)
  }
  if (
    options.outcome?.signal !== null
    && options.outcome?.signal !== undefined
  ) {
    fields.push(`signal: ${options.outcome.signal}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

describe('task admission and package contracts', () => {
  it('ships one independently installable provider-only Bundle patch', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      files?: string[]
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.dependencies).toHaveProperty(
      '@deepseek-ai/dsh-sdk-protocol',
      'workspace:^',
    )
    expect(manifest.dependencies).toHaveProperty('@openai/codex', CODEX_VERSION)
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-claude-code')

    const codexPackageJson = fileURLToPath(import.meta.resolve('@openai/codex/package.json'))
    const codexManifest = JSON.parse(readFileSync(codexPackageJson, 'utf8')) as {
      version: string
      bin: { codex: string }
      optionalDependencies: Record<string, string>
    }
    expect(codexManifest.version).toBe(CODEX_VERSION)
    expect(codexManifest.bin).toEqual({ codex: 'bin/codex.js' })
    expect(codexManifest.optionalDependencies).toEqual(Object.fromEntries(
      CODEX_PLATFORM_PACKAGES.map(packageName => [
        packageName,
        `npm:@openai/codex@${CODEX_VERSION}-${packageName.slice('@openai/codex-'.length)}`,
      ]),
    ))
    expect(codexAppServerArgv()).toEqual([
      process.execPath,
      resolve(dirname(codexPackageJson), codexManifest.bin.codex),
      'app-server',
      '--stdio',
    ])

    const lockfile = readFileSync(resolve(root, '../../../pnpm-lock.yaml'), 'utf8')
    for (const packageName of CODEX_PLATFORM_PACKAGES) {
      const suffix = packageName.slice('@openai/codex-'.length)
      expect(lockfile).toContain(`  '@openai/codex@${CODEX_VERSION}-${suffix}':`)
      expect(lockfile).toContain(
        `      '${packageName}': '@openai/codex@${CODEX_VERSION}-${suffix}'`,
      )
    }

    const parsed = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'))
    const rows = Array.isArray(parsed)
      ? (parsed as Array<{ insert?: Array<{ id?: string; name?: string }> }>).flatMap(entry => entry.insert ?? [])
      : []
    expect(rows).toEqual([{
      id: 'subagent-codex',
      name: '@deepseek-ai/dsh-subagent-codex',
    }])
    expect(JSON.stringify(rows)).not.toContain('tool-subagent')
  })

  it('accepts one or more text blocks and rejects empty or non-text tasks', () => {
    expect(textTask([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])).toEqual(['one', 'two'])
    expect(() => textTask([])).toThrow('only text blocks')
    expect(() => textTask([{ type: 'reasoning', text: 'hidden' }]))
      .toThrow('only text blocks')
    expect(() => textTask([{ type: 'text', text: ' \n ' }]))
      .toThrow('must not be empty')
  })

  it('registers the default descriptor, validates config, and unregisters on HMR', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(codex, {})
    const provider = ctx.subagents.getProvider('codex')!
    expect(provider).toMatchObject({
      name: 'codex',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    })
    expect(ctx.subagents.list()).toEqual(['codex'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])

    for (const disposeGraceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(ctx.plugin(codex, { disposeGraceMs }))
        .rejects.toThrow('disposeGraceMs must be a positive finite number')
    }
    await expect(ctx.plugin(codex, { disposeGraceMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(`disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    await ctx.fiber.dispose()
  })

  it('keeps named instances, runs, and HMR ownership isolated', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const safeChild = fakeChild()
    const bypassChild = fakeChild()
    const spawnSpecs: SubprocessSpawnSpec[] = []
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      spawnSpecs.push(spec)
      return spec.env?.DSH_CODEX_INSTANCE === 'safe'
        ? safeChild.handle
        : bypassChild.handle
    })
    const added: string[] = []
    const started: string[] = []
    const ended: string[] = []
    const removed: string[] = []
    ctx.on('subagent/provider-added', provider => void added.push(provider.name))
    ctx.on('subagent/start', info => void started.push(info.provider))
    ctx.on('subagent/end', info => void ended.push(info.provider))
    ctx.on('subagent/provider-removed', providerName => void removed.push(providerName))
    const safeFiber = await ctx.plugin(codex, {
      providerName: 'codex-safe',
      model: 'codex-safe-model',
      env: { DSH_CODEX_INSTANCE: 'safe' },
      permissionMode: 'never',
      disposeGraceMs: 11,
    })
    const bypassFiber = await ctx.plugin(codex, {
      providerName: 'codex-bypass',
      model: 'codex-bypass-model',
      env: { DSH_CODEX_INSTANCE: 'bypass' },
      permissionMode: 'dangerously-bypass-approvals-and-sandbox',
      disposeGraceMs: 29,
    })
    expect(ctx.subagents.list()).toEqual(['codex-safe', 'codex-bypass'])
    expect(added).toEqual(['codex-safe', 'codex-bypass'])

    const safeController = new AbortController()
    const safeStarting = ctx.subagents.start(
      'codex-safe',
      request(undefined, safeController.signal),
    )
    const bypassStarting = ctx.subagents.start('codex-bypass', request())
    for (const [child, model] of [
      [safeChild, 'codex-safe-model'],
      [bypassChild, 'codex-bypass-model'],
    ] as const) {
      const initialize = await child.peer.nextMethod('initialize')
      child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
      await child.peer.nextMethod('initialized')
      const threadStart = await child.peer.nextMethod('thread/start')
      expect(threadStart.params).toMatchObject({ model })
      child.peer.respond(threadStart, {
        thread: { id: 'thread-1', ephemeral: true },
      })
    }
    const [safeRun, bypassRun] = await Promise.all([
      safeStarting,
      bypassStarting,
    ])
    await safeFiber.dispose()
    expect(ctx.subagents.list()).toEqual(['codex-bypass'])
    expect(removed).toEqual(['codex-safe'])
    await expect(ctx.subagents.start('codex-safe', request()))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })

    const safeTurn = await safeChild.peer.nextMethod('turn/start')
    const bypassTurn = await bypassChild.peer.nextMethod('turn/start')
    safeChild.peer.respond(safeTurn, { turn: { id: 'turn-safe' } })
    bypassChild.peer.send(
      { id: bypassTurn.id, result: { turn: { id: 'turn-bypass' } } },
      agentMessage('bypass answer', 'final_answer', 'turn-bypass'),
      turnCompleted('completed', 'turn-bypass'),
    )
    await expect(bypassRun.result).resolves.toEqual({
      output: [{ type: 'text', text: 'bypass answer' }],
      stopReason: 'completed',
    })
    safeController.abort(new Error('stop only the safe instance'))
    await expect(safeRun.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    expect(spawnSpecs.map(spec => ({
      instance: spec.env?.DSH_CODEX_INSTANCE,
      graceMs: spec.graceMs,
    }))).toEqual([
      { instance: 'safe', graceMs: 11 },
      { instance: 'bypass', graceMs: 29 },
    ])

    await Promise.all([safeRun.dispose(), bypassRun.dispose()])
    expect([...started].sort()).toEqual(['codex-bypass', 'codex-safe'])
    expect([...ended].sort()).toEqual(['codex-bypass', 'codex-safe'])
    expect(safeChild.terminate).toHaveBeenCalledOnce()
    expect(bypassChild.terminate).toHaveBeenCalledOnce()
    await bypassFiber.dispose()
    expect(removed).toEqual(['codex-safe', 'codex-bypass'])
    await ctx.fiber.dispose()
  })

  it('rejects duplicate provider names without replacing the first instance', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const firstFiber = await ctx.plugin(codex, {
      providerName: 'codex-duplicate',
    })
    const first = ctx.subagents.getProvider('codex-duplicate')
    await expect(ctx.plugin(codex, {
      providerName: 'codex-duplicate',
      permissionMode: 'dangerously-bypass-approvals-and-sandbox',
    })).rejects.toMatchObject({ code: 'DUPLICATE_PROVIDER' })
    expect(ctx.subagents.getProvider('codex-duplicate')).toBe(first)
    expect(ctx.subagents.list()).toEqual(['codex-duplicate'])
    await firstFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('accepts an optional non-empty model and the three fixed permission modes', () => {
    expect(codex.Config({}).providerName).toBe('codex')
    expect(codex.Config({}).model).toBeUndefined()
    expect(codex.Config({ providerName: 'codex-safe' }).providerName)
      .toBe('codex-safe')
    expect(() => codex.Config({ providerName: '' })).toThrow()
    expect(codex.Config({ model: 'gpt-codex' }).model).toBe('gpt-codex')
    expect(() => codex.Config({ model: '' })).toThrow()
    expect(codex.Config({}).permissionMode).toBe(DEFAULT_CODEX_PERMISSION_MODE)
    for (const permissionMode of CODEX_PERMISSION_MODES) {
      expect(codex.Config({ permissionMode }).permissionMode).toBe(permissionMode)
    }
    for (const permissionMode of ['on-request', 'untrusted', 'future-mode']) {
      expect(() => codex.Config({ permissionMode } as never)).toThrow()
    }
  })

  it('resolves the safe permission default when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const child = fakeChild()
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
    codex.apply(ctx, { env: {}, disposeGraceMs: 3_000 })
    expect(ctx.subagents.getProvider('codex')).toBeDefined()
    const starting = ctx.subagents.start('codex', request())
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).not.toHaveProperty('model')
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      agentMessage('native model answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'native model answer' }],
      stopReason: 'completed',
    })
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    ['never', { approvalPolicy: 'never' }],
    ['approve-for-me', {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
    }],
    ['dangerously-bypass-approvals-and-sandbox', {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }],
  ] as const)('maps %s to the official thread/start fields', async (permissionMode, expected) => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(
      child.handle.stdout!,
      child.handle.stdin!,
      permissionMode,
    )
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
    await initializing
    await child.peer.nextMethod('initialized')
    const starting = wire.startThread('/workspace', new AbortController().signal)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: '/workspace',
      ephemeral: true,
      ...expected,
    })
    expect(threadStart.params).not.toHaveProperty('model')
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    await starting
    wire.close()
  })

  it('sends an explicit model on each ephemeral thread', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(
      child.handle.stdout!,
      child.handle.stdin!,
      'never',
      'codex-explicit-model',
    )
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
    await initializing
    await child.peer.nextMethod('initialized')
    const starting = wire.startThread('/workspace', new AbortController().signal)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: '/workspace',
      ephemeral: true,
      model: 'codex-explicit-model',
      approvalPolicy: 'never',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    await starting
    wire.close()
  })

  it('requires a parent session cwd without suggesting unsupported config', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await ctx.plugin(codex, {})

    await expect(ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: {
        id: 'parent-without-cwd',
        session: { header: {} },
      } as unknown as Agent,
      signal: new AbortController().signal,
    })).rejects.toThrow(
      'subagent-codex: no working directory for the child — delegate from a parent session that has one',
    )
    expect(spawn).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('keeps the namespace export shape', () => {
    expect('default' in codex).toBe(false)
    expect(codex.name).toBe('subagent-codex')
    expect(codex.inject).toEqual(['subagents', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(codex)).toBe(codex)
  })
})

describe('CodexAppServerWire', () => {
  it('sends the fixed handshake, thread, and turn payloads and keeps final_answer', async () => {
    const child = fakeChild()
    const wire = defaultWire(child)
    expect(wire.collectOutput()).toEqual([])
    wire.start()

    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    expect(initialize.params).toEqual({
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    })
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
    await initializing
    await child.peer.nextMethod('initialized')

    const starting = wire.startThread('/workspace', new AbortController().signal)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: '/workspace',
      ephemeral: true,
      approvalPolicy: 'never',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    await starting

    const result = wire.runTurn(
      ['first', 'second'],
      new AbortController().signal,
    )
    const turnStart = await child.peer.nextMethod('turn/start')
    expect(turnStart.params).toEqual({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'first', text_elements: [] },
        { type: 'text', text: 'second', text_elements: [] },
      ],
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      },
      agentMessage('other thread', 'final_answer', 'turn-1', 'thread-2'),
      agentMessage('other turn', 'final_answer', 'turn-2'),
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'reasoning', text: 'not output' },
        },
      },
      agentMessage('commentary', 'commentary'),
      agentMessage('unphased', null),
      agentMessage('first final', 'final_answer'),
      agentMessage('last final', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'last final' }],
      stopReason: 'completed',
    })
    expect(wire.collectOutput()).toEqual([{ type: 'text', text: 'last final' }])
    wire.close()
    wire.close()
  })

  it('uses the last nullable-phase answer when no explicit final exists', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('first', null),
      agentMessage('fallback', null),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'fallback' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('groups representative string errors without changing stop reasons', async () => {
    const scenarios = [
      ['contextWindowExceeded', 'limit', 'max-tokens'],
      ['sessionBudgetExceeded', 'limit', 'error'],
      ['cyberPolicy', 'access-policy', 'error'],
      ['misalignmentPolicyViolation', 'access-policy', 'error'],
      ['serverOverloaded', 'service', 'error'],
      ['badRequest', 'product-error', 'error'],
      ['sandboxError', 'access-policy', 'error'],
    ] as const
    for (const [codexErrorInfo, category, stopReason] of scenarios) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(
        agentMessage('partial answer', null),
        turnCompleted('failed', 'turn-1', 'thread-1', {
          message: 'SECRET_TOKEN in /private/secret.txt',
          codexErrorInfo,
        }),
      )
      if (stopReason === 'max-tokens') {
        await expect(result).resolves.toEqual({
          output: [{ type: 'text', text: 'partial answer' }],
          stopReason: 'max-tokens',
        })
      } else {
        await expect(result).rejects.toThrow(`status failed: ${category}`)
      }
      expect(wire.collectFailure()).toEqual({
        stage: 'turn',
        category,
      })
      expect(JSON.stringify(wire.collectFailure())).not.toContain('SECRET_TOKEN')
      expect(JSON.stringify(wire.collectFailure())).not.toContain('/private/secret.txt')
      wire.close()
    }
  })

  it('groups object errors and retains only numeric HTTP status', async () => {
    const scenarios = [
      ['httpConnectionFailed', { httpStatusCode: 503 }, 'transport', 503],
      ['responseStreamDisconnected', {}, 'transport', undefined],
      ['responseTooManyFailedAttempts', { httpStatusCode: '503' }, 'transport', undefined],
      ['activeTurnNotSteerable', { turnKind: 'review' }, 'product-error', undefined],
    ] as const
    for (const [codexErrorInfo, detail, category, httpStatus] of scenarios) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'SECRET_TOKEN in /private/secret.txt',
        codexErrorInfo: { [codexErrorInfo]: detail },
      }))
      await expect(result).rejects.toThrow(`status failed: ${category}`)
      expect(wire.collectFailure()).toEqual({
        stage: 'turn',
        category,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      })
      expect(JSON.stringify(wire.collectFailure())).not.toContain('turnKind')
      wire.close()
    }
  })

  it('uses unknown for version-external or malformed error info', async () => {
    for (const codexErrorInfo of [
      'futureError',
      { futureVariant: { message: 'SECRET_TOKEN' } },
      {
        httpConnectionFailed: { httpStatusCode: 503 },
        otherVariant: {},
      },
      { httpConnectionFailed: null },
    ]) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'SECRET_TOKEN in /private/secret.txt',
        codexErrorInfo,
      }))
      await expect(result).rejects.toThrow('status failed: unknown')
      expect(wire.collectFailure()).toEqual({
        stage: 'turn',
        category: 'unknown',
      })
      wire.close()
    }
  })

  it('rejects invalid handshake, thread, and turn response shapes', async () => {
    {
      const child = fakeChild()
      const wire = defaultWire(child)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      const frame = await child.peer.nextMethod('initialize')
      child.peer.respond(frame, null)
      await expect(pending).rejects.toThrow('invalid initialize response')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = defaultWire(child)
      wire.start()
      const pending = wire.startThread('/workspace', new AbortController().signal)
      const frame = await child.peer.nextMethod('thread/start')
      child.peer.respond(frame, { thread: { id: 'thread-1', ephemeral: false } })
      await expect(pending).rejects.toThrow('did not create an ephemeral thread')
      wire.close()
    }
    {
      const { child, wire } = await initializeWire()
      const pending = wire.runTurn(['task'], new AbortController().signal)
      const frame = await child.peer.nextMethod('turn/start')
      child.peer.respond(frame, { turn: { id: '' } })
      await expect(pending).rejects.toThrow('turn/start turn id')
      expect(wire.collectFailure()).toEqual({
        stage: 'turn-start',
        category: 'unknown',
      })
      wire.close()
    }
  })

  it('fails closed for empty output, malformed messages, phases, and terminal status', async () => {
    const scenarios: Array<{
      readonly frames: JsonObject[]
      readonly message: string
      readonly category: 'invalid-result' | 'unknown'
    }> = [
      {
        frames: [turnCompleted('completed')],
        message: 'without a final answer',
        category: 'invalid-result',
      },
      {
        frames: [
          agentMessage('fallback', null),
          agentMessage(' \n ', 'final_answer'),
          turnCompleted('completed'),
        ],
        message: 'without a final answer',
        category: 'invalid-result',
      },
      {
        frames: [agentMessage(42, 'final_answer')],
        message: 'invalid agent message',
        category: 'unknown',
      },
      {
        frames: [agentMessage('answer', 'future_phase')],
        message: 'unknown agent message phase',
        category: 'unknown',
      },
      {
        frames: [turnCompleted('failed', 'turn-1', 'thread-1', { message: 'no' })],
        message: 'status failed',
        category: 'unknown',
      },
      {
        frames: [turnCompleted('failed', 'turn-1', 'thread-1', 'SECRET_TOKEN')],
        message: 'status failed',
        category: 'unknown',
      },
      {
        frames: [turnCompleted('interrupted')],
        message: 'status interrupted',
        category: 'unknown',
      },
      {
        frames: [turnCompleted('inProgress')],
        message: 'invalid terminal turn status',
        category: 'unknown',
      },
    ]
    for (const scenario of scenarios) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      await nextTask()
      child.peer.send(...scenario.frames)
      await expect(result).rejects.toThrow(scenario.message)
      expect(wire.collectFailure()).toEqual({
        stage: 'turn',
        category: scenario.category,
      })
      wire.close()
    }
  })

  it('fails closed when terminal notification params are not an object', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send({ method: 'turn/completed', params: null })
    await expect(result).rejects.toThrow('invalid turn/completed thread id')
    wire.close()
  })

  it('keeps an unsupported request authoritative over an early terminal in the same chunk', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      { id: 'future-request', method: 'future/request', params: {} },
      agentMessage('early answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).rejects.toThrow('unsupported app-server request')
    wire.close()
  })

  it('answers all five unattended request classes without granting authority', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')

    child.peer.send({
      id: 'command',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['decline', 'cancel'],
        command: 'cat /private/secret.txt',
      },
    })
    expect(await child.peer.nextResponse('command')).toMatchObject({
      result: { decision: 'cancel' },
    })
    expect(wire.collectDiagnostic()).toBeUndefined()

    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    expect(wire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval',
    )
    const requests = [
      {
        id: 'command-decline',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['decline'],
        },
        result: { decision: 'decline' },
        diagnostic: 'Codex unattended decision (mode: never; request: command approval; decision: declined): the provider does not grant interactive approval',
      },
      {
        id: 'file',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['decline'],
        },
        result: { decision: 'decline' },
        diagnostic: 'Codex unattended decision (mode: never; request: file approval; decision: declined): the provider does not grant interactive approval',
      },
      {
        id: 'file-cancel',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['cancel'],
        },
        result: { decision: 'cancel' },
        diagnostic: 'Codex unattended decision (mode: never; request: file approval; decision: cancelled): the provider does not grant interactive approval',
      },
      {
        id: 'file-default',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        result: { decision: 'decline' },
        diagnostic: 'Codex unattended decision (mode: never; request: file approval; decision: declined): the provider does not grant interactive approval',
      },
      {
        id: 'permissions',
        method: 'item/permissions/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        result: { permissions: {}, scope: 'turn' },
        diagnostic: 'Codex unattended decision (mode: never; request: permission grant; decision: denied): the provider grants no additional turn permissions',
      },
      {
        id: 'user-input',
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-1', turnId: 'turn-1', questions: [] },
        result: { answers: {} },
        diagnostic: 'Codex unattended decision (mode: never; request: user input; decision: empty response): the provider does not collect interactive answers',
      },
      {
        id: 'mcp',
        method: 'mcpServer/elicitation/request',
        params: { threadId: 'thread-1', turnId: null },
        result: { action: 'decline', content: null, _meta: null },
        diagnostic: 'Codex unattended decision (mode: never; request: MCP elicitation; decision: declined): the provider does not collect interactive MCP input',
      },
    ] as const
    for (const serverRequest of requests) {
      child.peer.send(serverRequest)
      expect(await child.peer.nextResponse(serverRequest.id)).toMatchObject({
        result: serverRequest.result,
      })
      expect(wire.collectDiagnostic()).toBe(serverRequest.diagnostic)
    }
    expect(wire.collectDiagnostic()).not.toContain('/private/secret.txt')

    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('records only a safe diagnostic for an explicit sandbox failure', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'failed at /private/secret.txt with SECRET_TOKEN',
      additionalDetails: 'raw command payload',
      codexErrorInfo: 'sandboxError',
    }))
    await expect(result).rejects.toThrow('status failed')
    expect(wire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: sandbox execution; decision: failed): Codex reported a sandbox failure',
    )
    expect(wire.collectDiagnostic()).not.toContain('SECRET_TOKEN')
    expect(wire.collectDiagnostic()).not.toContain('/private/secret.txt')
    wire.close()
  })

  it('records declined command and file items without retaining their payloads', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          status: 'declined',
          command: 'cat /private/secret.txt',
        },
      },
    })
    await nextTask()
    expect(wire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: command execution; decision: declined): Codex declined the command under the selected permission mode',
    )
    expect(wire.collectDiagnostic()).not.toContain('/private/secret.txt')

    child.peer.send(
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'fileChange',
            status: 'declined',
            patch: 'SECRET_TOKEN in /private/secret.txt',
          },
        },
      },
      turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'SECRET_TOKEN in /private/secret.txt',
        codexErrorInfo: 'other',
      }),
    )
    await expect(result).rejects.toThrow('status failed')
    expect(wire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: file change; decision: declined): Codex declined the file change under the selected permission mode',
    )
    expect(wire.collectDiagnostic()).not.toContain('SECRET_TOKEN')
    expect(wire.collectDiagnostic()).not.toContain('/private/secret.txt')
    wire.close()
  })

  it('keeps a newer request diagnostic after replaying an older early item', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'fileChange', status: 'declined' },
      },
    })
    await nextTask()
    child.peer.send({
      id: 'newer-command-request',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['cancel'],
      },
    })
    await child.peer.nextResponse('newer-command-request')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(wire.collectDiagnostic()).toContain('request: command approval')
    wire.close()
  })

  it('fails the run on unknown requests or wrong request association', async () => {
    for (const serverRequest of [
      {
        id: 'unknown',
        method: 'future/request',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      },
      {
        id: 'approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['accept'],
        },
      },
      {
        id: 'malformed-approval',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: 'decline',
        },
      },
      {
        id: 'thread',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-2', turnId: 'turn-1' },
      },
      {
        id: 'turn',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-2' },
      },
    ]) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      await nextTask()
      child.peer.send(serverRequest)
      const response = await child.peer.nextResponse(serverRequest.id)
      expect(response.error).toMatchObject({ code: -32603 })
      await expect(result).rejects.toThrow()
      wire.close()
    }
  })

  it('rejects conflicting early turn identities before accepting output', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-early' } },
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-response' } })
    await expect(result).rejects.toThrow('did not match the active turn')
    wire.close()
  })

  it('does not retain a diagnostic from a mismatched early item', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-early',
        item: { type: 'fileChange', status: 'declined' },
      },
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-response' } })
    await expect(result).rejects.toThrow('did not match the active turn')
    expect(wire.collectDiagnostic()).toBeUndefined()
    wire.close()
  })

  it('does not retain a diagnostic from a mismatched provisional request', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send({
      id: 'provisional-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-early',
        availableDecisions: ['cancel'],
      },
    })
    await child.peer.nextResponse('provisional-approval')
    child.peer.respond(turnStart, { turn: { id: 'turn-response' } })
    await expect(result).rejects.toThrow('did not match the active turn')
    expect(wire.collectDiagnostic()).toBeUndefined()
    wire.close()
  })

  it('rejects conflicting early notifications and requests before turn/start', async () => {
    {
      const { child, wire } = await initializeWire()
      child.peer.send({
        id: 'too-early',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      })
      const response = await child.peer.nextResponse('too-early')
      expect(response.error).toMatchObject({ code: -32603 })
      wire.close()
    }
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      await child.peer.nextMethod('turn/start')
      child.peer.send(
        {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
        agentMessage('wrong', 'final_answer', 'turn-2'),
      )
      await expect(result).rejects.toThrow('conflicting turns')
      wire.close()
    }
  })

  it('interrupts only an active open turn and contains remote interrupt failure', async () => {
    const { child, wire } = await initializeWire()
    wire.interrupt()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    wire.interrupt()
    const interrupt = await child.peer.nextMethod('turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
    child.peer.send({
      id: interrupt.id,
      error: { code: -32000, message: 'already done' },
    })
    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
    wire.interrupt()
  })

  it('ignores unrelated and out-of-window notifications', async () => {
    const { child, wire } = await initializeWire()
    child.peer.send(
      {
        method: 'turn/started',
        params: { threadId: 'thread-2', turn: { id: 'turn-other' } },
      },
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-before' } },
      },
      agentMessage('before', 'final_answer'),
      { method: 'future/notification', params: {} },
      turnCompleted('completed'),
      turnCompleted('completed', 'turn-other', 'thread-2'),
    )
    await nextTask()

    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      agentMessage('wrong turn', 'final_answer', 'turn-2'),
      turnCompleted('completed', 'turn-2'),
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('rejects pending work on abort, EOF, and stream error', async () => {
    {
      const child = fakeChild()
      const wire = defaultWire(child)
      wire.start()
      const controller = new AbortController()
      controller.abort('pre-aborted')
      await expect(wire.initialize(controller.signal))
        .rejects.toThrow('app-server request aborted: pre-aborted')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = defaultWire(child)
      wire.start()
      const controller = new AbortController()
      const pending = wire.initialize(controller.signal)
      await child.peer.nextMethod('initialize')
      controller.abort(new Error('cancel initialize'))
      await expect(pending).rejects.toThrow('cancel initialize')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = defaultWire(child)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.fromChild.end()
      await expect(pending).rejects.toThrow(/(?:protocol stream|JSON-RPC input) closed/)
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = defaultWire(child)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.fromChild.emit('error', new Error('stdout broke'))
      await expect(pending).rejects.toThrow('stdout broke')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = defaultWire(child)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.toChild.emit('error', new Error('stdin broke'))
      await expect(pending).rejects.toThrow('stdin broke')
      wire.close()
      child.toChild.emit('error', new Error('late stdin close'))
    }
  })
})

describe('run lifecycle and quiescence', () => {
  it('spawns the fixed app-server, publishes after thread creation, and disposes once', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child.handle)
    const starting = startCodexRun(
      request([{ type: 'text', text: 'task' }]),
      runSpec(child, { env: { OPENAI_API_KEY: 'fake' }, spawn }),
    )
    let published = false
    void starting.then(() => { published = true })
    const initialize = await child.peer.nextMethod('initialize')
    expect(published).toBe(false)
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(published).toBe(false)
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    expect(spawn).toHaveBeenCalledWith({
      argv: codexAppServerArgv(),
      cwd: process.cwd(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: DEFAULT_DISPOSE_GRACE_MS,
      env: { OPENAI_API_KEY: 'fake' },
    })
    expect(run.localAgent).toBeUndefined()

    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal
    await nextTask()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
  })

  it('settles local cancellation immediately and sends best-effort interrupt', async () => {
    const controller = new AbortController()
    const { child, run, turnStart } = await publishRun(
      fakeChild(),
      controller.signal,
    )
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    controller.abort(new Error('stop'))
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    expect(await child.peer.nextMethod('turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    await run.dispose()
  })

  it('reports turn-start failures and omits captured facts after success', async () => {
    {
      const { child, run, turnStart } = await publishRun()
      child.peer.respond(turnStart, { turn: { id: '' } })
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedFailureDiagnostic('turn-start', 'unknown'),
        stopReason: 'error',
      })
      await run.dispose()
    }
    {
      const { child, run, turnStart } = await publishRun()
      child.peer.send({
        id: 'successful-approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['cancel'],
        },
      })
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      await child.peer.nextResponse('successful-approval')
      child.peer.send(
        agentMessage('answer', 'final_answer'),
        turnCompleted('completed'),
      )
      await expect(run.result).resolves.toEqual({
        output: [{ type: 'text', text: 'answer' }],
        stopReason: 'completed',
      })
      await run.dispose()
    }
  })

  it('preserves representative terminal categories, HTTP status, and mapping', async () => {
    const scenarios = [
      ['contextWindowExceeded', 'limit', 'max-tokens', undefined],
      ['sessionBudgetExceeded', 'limit', 'error', undefined],
      ['unauthorized', 'access-policy', 'error', undefined],
      ['internalServerError', 'service', 'error', undefined],
      [{ httpConnectionFailed: { httpStatusCode: 503 } }, 'transport', 'error', 503],
      [{ activeTurnNotSteerable: { turnKind: 'review' } }, 'product-error', 'error', undefined],
      ['futureError', 'unknown', 'error', undefined],
    ] as const
    for (const [codexErrorInfo, category, stopReason, httpStatus] of scenarios) {
      const { child, run, turnStart } = await publishRun()
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(
        agentMessage('partial answer', null),
        turnCompleted('failed', 'turn-1', 'thread-1', {
          message: 'SECRET_TOKEN in /private/secret.txt',
          codexErrorInfo,
        }),
      )
      const result = await run.result
      expect(result).toEqual({
        output: [{ type: 'text', text: 'partial answer' }],
        diagnostic: expectedFailureDiagnostic('turn', category, {
          ...(httpStatus === undefined ? {} : { httpStatus }),
        }),
        stopReason,
      })
      expect(result.diagnostic).not.toContain('SECRET_TOKEN')
      expect(result.diagnostic).not.toContain('/private/secret.txt')
      expect(result.diagnostic).not.toContain('turnKind')
      await run.dispose()
    }
  })

  it('includes a structured permission fact in a max-token result', async () => {
    const { child, run, turnStart } = await publishRun()
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send({
      id: 'approval-before-limit',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['cancel'],
      },
    })
    await child.peer.nextResponse('approval-before-limit')
    child.peer.send(
      agentMessage('partial answer', null),
      turnCompleted('failed', 'turn-1', 'thread-1', {
        codexErrorInfo: 'contextWindowExceeded',
      }),
    )
    child.settle({ exitCode: 17, signal: null })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'partial answer' }],
      diagnostic: `${expectedFailureDiagnostic('turn', 'limit', { outcome: { exitCode: 17, signal: null } })}\nCodex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval`,
      stopReason: 'max-tokens',
    })
    await run.dispose()
  })

  it('flattens child exit and protocol failures after publication', async () => {
    const errors: string[] = []
    const outcomes: SubprocessOutcome[] = [
      { exitCode: 9, signal: null },
      { exitCode: null, signal: 'SIGABRT' },
      { exitCode: null, signal: null },
    ]
    for (const outcome of outcomes) {
      const child = fakeChild({ exitOnTerminate: false })
      const { run } = await publishRun(child, undefined, {
        onError: (error) => { errors.push(error.message) },
      })
      child.settle(outcome)
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedFailureDiagnostic('process', 'process', {
          outcome,
        }),
        stopReason: 'error',
      })
      expect(errors.at(-1)).toBe(
        `subagent-codex: ${expectedFailureDiagnostic('process', 'process', { outcome })}`,
      )
      await run.dispose().catch(() => {})
    }
    {
      const outcome = { exitCode: 17, signal: null } as const
      const child = fakeChild({ exitOnTerminate: false })
      const { run, turnStart } = await publishRun(child, undefined, {
        disposeGraceMs: 0.5,
      })
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      vi.spyOn(child.handle, 'waitForExit').mockImplementationOnce(async (signal?: AbortSignal) => {
        expect(signal).toBeDefined()
        child.settle(outcome)
        return true
      })
      child.fromChild.emit('end')
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedFailureDiagnostic('process', 'process', {
          outcome,
        }),
        stopReason: 'error',
      })
      await run.dispose().catch(() => {})
    }
    {
      const child = fakeChild({ exitOnTerminate: false })
      const { run, turnStart } = await publishRun(child)
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      setImmediate(() => {
        child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
          codexErrorInfo: 'other',
        }))
      })
      child.settle({ exitCode: 17, signal: null })
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedFailureDiagnostic('turn', 'product-error', {
          outcome: { exitCode: 17, signal: null },
        }),
        stopReason: 'error',
      })
      await run.dispose().catch(() => {})
    }
    {
      const child = fakeChild({ exitOnTerminate: false })
      const { run, turnStart } = await publishRun(child)
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(
        agentMessage('answer', 'final_answer'),
        turnCompleted('completed'),
      )
      child.fromChild.end()
      child.settle({ exitCode: 17, signal: null })
      await expect(run.result).resolves.toEqual({
        output: [{ type: 'text', text: 'answer' }],
        stopReason: 'completed',
      })
      await run.dispose().catch(() => {})
    }
    {
      const child = fakeChild()
      const { run, turnStart } = await publishRun(child, undefined, {
        disposeGraceMs: 10,
        onError: () => { throw new Error('diagnostic sink') },
      })
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.fromChild.end()
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedFailureDiagnostic('turn', 'unknown'),
        stopReason: 'error',
      })
      await run.dispose()
    }
    {
      const child = fakeChild()
      const { run, turnStart } = await publishRun(child)
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.stderr.emit('error', new Error('stderr broke'))
      child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
      await expect(run.result).resolves.toEqual({
        output: [{ type: 'text', text: 'answer' }],
        stopReason: 'completed',
      })
      await run.dispose()
      expect(child.stderr.listenerCount('error')).toBe(0)
    }
  })

  it('attaches a safe permission diagnostic when a published run fails', async () => {
    const { child, run, turnStart } = await publishRun()
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send({
      id: 'approval-diagnostic',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['cancel'],
        command: 'cat /private/secret.txt',
      },
    })
    expect(await child.peer.nextResponse('approval-diagnostic')).toMatchObject({
      result: { decision: 'cancel' },
    })
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'SECRET_TOKEN in /private/secret.txt',
      codexErrorInfo: 'other',
    }))
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: `${expectedFailureDiagnostic('turn', 'product-error')}\nCodex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval`,
      stopReason: 'error',
    })
    await run.dispose()
  })

  it('drains queued stderr to the Host without classifying it', async () => {
    hostStderrWrite.capture = true
    hostStderrWrite.chunks.length = 0
    const { child, run, turnStart } = await publishRun()
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'fixture terminal failure',
      codexErrorInfo: 'badRequest',
    }))
    setImmediate(() => {
      child.stderr.write('approval policy is Never; reject command')
    })
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: expectedFailureDiagnostic('turn', 'product-error'),
      stopReason: 'error',
    })
    expect(Buffer.concat(hostStderrWrite.chunks).toString())
      .toContain('approval policy is Never; reject command')
    await run.dispose()
    hostStderrWrite.capture = false
  })

  it('forwards stderr without copying or classifying it', async () => {
    const child = fakeChild()
    hostStderrWrite.capture = true
    hostStderrWrite.chunks.length = 0
    const { run, turnStart } = await publishRun(child)
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.stderr.write('SECRET_TOKEN approval policy is Ne')
    child.stderr.write('ver; reject command — /private/secret.txt')
    child.stderr.emit('data', 'string stderr suffix')
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'fixture terminal failure',
      codexErrorInfo: 'badRequest',
    }))
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: expectedFailureDiagnostic('turn', 'product-error'),
      stopReason: 'error',
    })
    expect(Buffer.concat(hostStderrWrite.chunks).toString()).toContain('SECRET_TOKEN')
    expect(hostStderrWrite.chunks).toHaveLength(3)
    await run.dispose()
    expect(child.stderr.listenerCount('data')).toBe(0)
    hostStderrWrite.capture = false
  })

  it('contains host stderr write failures without changing run settlement', async () => {
    const child = fakeChild()
    hostStderrWrite.capture = true
    hostStderrWrite.failNext = true
    const { run, turnStart } = await publishRun(child)
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.stderr.write('approval policy is Never; reject command')
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'fixture terminal failure',
      codexErrorInfo: 'badRequest',
    }))
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: expectedFailureDiagnostic('turn', 'product-error'),
      stopReason: 'error',
    })
    await run.dispose()
    hostStderrWrite.capture = false
  })

  it('rejects before spawn when pre-aborted and rolls back startup failures', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()
    await expect(startCodexRun(
      request(undefined, controller.signal),
      {
        cwd: process.cwd(),
        permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
        env: {},
        disposeGraceMs: 10,
        spawn,
      },
    )).rejects.toThrow('aborted before app-server startup')
    expect(spawn).not.toHaveBeenCalled()

    const spawnFailure = startCodexRun(request(), {
      cwd: process.cwd(),
      permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
      env: {},
      disposeGraceMs: 10,
      spawn: () => { throw new Error('SECRET_TOKEN spawn failure') },
    })
    await expect(spawnFailure)
      .rejects.toThrow(expectedFailureDiagnostic('initialize', 'unknown'))
    await expect(spawnFailure).rejects.not.toThrow('SECRET_TOKEN')

    const asyncSpawnFailureChild = fakeChild({
      doneError: new Error('SECRET_TOKEN async spawn failure'),
    })
    const asyncSpawnFailure = startCodexRun(
      request(),
      runSpec(asyncSpawnFailureChild),
    )
    await expect(asyncSpawnFailure)
      .rejects.toThrow(expectedFailureDiagnostic('initialize', 'unknown'))
    await expect(asyncSpawnFailure).rejects.not.toThrow('SECRET_TOKEN')
    expect(asyncSpawnFailureChild.terminate).toHaveBeenCalledOnce()
    expect(asyncSpawnFailureChild.waitForExit).toHaveBeenCalledOnce()

    const child = fakeChild()
    const starting = startCodexRun(request(), runSpec(child))
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, null)
    await expect(starting)
      .rejects.toThrow(expectedFailureDiagnostic('initialize', 'unknown'))
    await expect(starting).rejects.not.toThrow('invalid initialize response')
    expect(child.terminate).toHaveBeenCalledTimes(1)

    const cleanupFailureChild = fakeChild({
      waitForExitError: new Error('SECRET_TOKEN wait failure'),
    })
    const cleanupFailure = startCodexRun(
      request(),
      runSpec(cleanupFailureChild),
    )
    const cleanupFailureInitialize = await cleanupFailureChild.peer
      .nextMethod('initialize')
    cleanupFailureChild.peer.respond(cleanupFailureInitialize, null)
    const cleanupError: unknown = await cleanupFailure.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(cleanupError).toBeInstanceOf(AggregateError)
    expect(String(cleanupError)).toContain(
      expectedFailureDiagnostic('initialize', 'unknown'),
    )
    expect(String(cleanupError)).toContain(expectedFailureDiagnostic(
      'teardown',
      'unknown',
      { outcome: { exitCode: 0, signal: null } },
    ))
    expect(String(cleanupError)).not.toContain('SECRET_TOKEN')

    const cleanupRaceAbort = new AbortController()
    const cleanupRaceChild = fakeChild({ exitOnTerminate: false })
    const cleanupRace = startCodexRun(
      request(undefined, cleanupRaceAbort.signal),
      runSpec(cleanupRaceChild),
    )
    const cleanupRaceInitialize = await cleanupRaceChild.peer.nextMethod('initialize')
    cleanupRaceChild.peer.respond(cleanupRaceInitialize, null)
    await nextTask()
    cleanupRaceAbort.abort(new Error('cancelled during cleanup'))
    cleanupRaceChild.settle()
    await expect(cleanupRace)
      .rejects.toThrow('aborted before run publication')

    const threadChild = fakeChild()
    const threadStarting = startCodexRun(request(), runSpec(threadChild))
    const threadInitialize = await threadChild.peer.nextMethod('initialize')
    threadChild.peer.respond(threadInitialize, { userAgent: 'codex-cli 0.149.1' })
    await threadChild.peer.nextMethod('initialized')
    const invalidThread = await threadChild.peer.nextMethod('thread/start')
    threadChild.peer.respond(invalidThread, { thread: { id: '', ephemeral: true } })
    await expect(threadStarting)
      .rejects.toThrow(expectedFailureDiagnostic('thread-start', 'unknown'))
    await expect(threadStarting).rejects.not.toThrow('thread/start thread id')

    const exitedThreadChild = fakeChild({ exitOnTerminate: false })
    const exitedThreadStarting = startCodexRun(
      request(),
      runSpec(exitedThreadChild),
    )
    const exitedThreadInitialize = await exitedThreadChild.peer.nextMethod('initialize')
    exitedThreadChild.peer.respond(exitedThreadInitialize, {
      userAgent: 'codex-cli 0.149.1',
    })
    await exitedThreadChild.peer.nextMethod('initialized')
    await exitedThreadChild.peer.nextMethod('thread/start')
    exitedThreadChild.settle({ exitCode: null, signal: 'SIGABRT' })
    await expect(exitedThreadStarting).rejects.toThrow(expectedFailureDiagnostic(
      'thread-start',
      'unknown',
      { outcome: { exitCode: null, signal: 'SIGABRT' } },
    ))

    const eofBeforeCloseChild = fakeChild({ exitOnTerminate: false })
    const eofBeforeCloseStarting = startCodexRun(
      request(),
      runSpec(eofBeforeCloseChild),
    )
    const eofBeforeCloseInitialize = await eofBeforeCloseChild.peer
      .nextMethod('initialize')
    eofBeforeCloseChild.peer.respond(eofBeforeCloseInitialize, {
      userAgent: 'codex-cli 0.149.1',
    })
    await eofBeforeCloseChild.peer.nextMethod('initialized')
    await eofBeforeCloseChild.peer.nextMethod('thread/start')
    eofBeforeCloseChild.fromChild.emit('end')
    setImmediate(() => {
      eofBeforeCloseChild.settle({ exitCode: 23, signal: null })
    })
    await expect(eofBeforeCloseStarting).rejects.toThrow(
      expectedFailureDiagnostic('thread-start', 'unknown', {
        outcome: { exitCode: 23, signal: null },
      }),
    )

    const stderrChild = fakeChild()
    const stderrStarting = startCodexRun(request(), runSpec(stderrChild))
    const stderrInitialize = await stderrChild.peer.nextMethod('initialize')
    stderrChild.stderr.emit('error', new Error('startup stderr broke'))
    stderrChild.peer.respond(stderrInitialize, { userAgent: 'codex-cli 0.149.1' })
    await stderrChild.peer.nextMethod('initialized')
    const stderrThreadStart = await stderrChild.peer.nextMethod('thread/start')
    stderrChild.peer.respond(stderrThreadStart, {
      thread: { id: 'thread-1', ephemeral: true },
    })
    const stderrRun = await stderrStarting
    const stderrTurnStart = await stderrChild.peer.nextMethod('turn/start')
    stderrChild.peer.send(
      { id: stderrTurnStart.id, result: { turn: { id: 'turn-1' } } },
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(stderrRun.result).resolves.toMatchObject({ stopReason: 'completed' })
    await stderrRun.dispose()
    expect(stderrChild.stderr.listenerCount('error')).toBe(0)
  })

  it('rolls back an abort that wins immediately after thread creation', async () => {
    const controller = new AbortController()
    const child = fakeChild()
    const starting = startCodexRun(
      request(undefined, controller.signal),
      runSpec(child),
    )
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: process.cwd(),
      ephemeral: true,
      approvalPolicy: 'never',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    controller.abort('startup race')
    await expect(starting).rejects.toThrow('aborted before run publication')
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps overlapping runs isolated', async () => {
    const initialStderrListeners = {
      error: process.stderr.listenerCount('error'),
      unpipe: process.stderr.listenerCount('unpipe'),
      close: process.stderr.listenerCount('close'),
      finish: process.stderr.listenerCount('finish'),
    }
    const runs = await Promise.all(
      Array.from({ length: 6 }, () => publishRun(fakeChild())),
    )
    expect({
      error: process.stderr.listenerCount('error'),
      unpipe: process.stderr.listenerCount('unpipe'),
      close: process.stderr.listenerCount('close'),
      finish: process.stderr.listenerCount('finish'),
    }).toEqual(initialStderrListeners)
    for (const [index, entry] of runs.entries()) {
      const id = `turn-${index + 1}`
      entry.child.peer.send(
        { id: entry.turnStart.id, result: { turn: { id } } },
        agentMessage(`answer-${index + 1}`, 'final_answer', id),
        turnCompleted('completed', id),
      )
    }
    const results = await Promise.all(runs.map(entry => entry.run.result))
    expect(results.map(result => result.output)).toEqual(
      Array.from({ length: 6 }, (_, index) => [
        { type: 'text', text: `answer-${index + 1}` },
      ]),
    )
    expect(runs[0]!.run.id).not.toBe(runs[1]!.run.id)
    await Promise.all(runs.map(entry => entry.run.dispose()))
  })

  it('isolates permission modes and diagnostics across overlapping runs', async () => {
    const first = await publishRun(fakeChild(), undefined, {
      permissionMode: 'never',
    })
    const second = await publishRun(fakeChild(), undefined, {
      permissionMode: 'dangerously-bypass-approvals-and-sandbox',
    })
    first.child.peer.respond(first.turnStart, { turn: { id: 'turn-never' } })
    second.child.peer.respond(second.turnStart, { turn: { id: 'turn-bypass' } })
    await nextTask()
    first.child.peer.send({
      id: 'never-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-never',
        availableDecisions: ['cancel'],
      },
    })
    second.child.peer.send({
      id: 'bypass-elicitation',
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread-1', turnId: null },
    })
    await Promise.all([
      first.child.peer.nextResponse('never-approval'),
      second.child.peer.nextResponse('bypass-elicitation'),
    ])
    first.child.peer.send(turnCompleted('failed', 'turn-never', 'thread-1', {
      message: 'first failure',
      codexErrorInfo: 'other',
    }))
    second.child.peer.send(turnCompleted('failed', 'turn-bypass', 'thread-1', {
      message: 'second failure',
      codexErrorInfo: 'other',
    }))
    await expect(first.run.result).resolves.toEqual({
      output: [],
      diagnostic: `${expectedFailureDiagnostic('turn', 'product-error')}\nCodex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval`,
      stopReason: 'error',
    })
    await expect(second.run.result).resolves.toEqual({
      output: [],
      diagnostic: `${expectedFailureDiagnostic('turn', 'product-error')}\nCodex unattended decision (mode: dangerously-bypass-approvals-and-sandbox; request: MCP elicitation; decision: declined): the provider does not collect interactive MCP input`,
      stopReason: 'error',
    })
    await Promise.all([first.run.dispose(), second.run.dispose()])
  })

  it('uses the registered provider config and logs flattened errors', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const child = fakeChild()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
    }) as typeof ctx.logger.warn
    await ctx.plugin(codex, {
      providerName: 'codex-diagnostic',
      model: 'codex-diagnostic-model',
      env: { OPENAI_API_KEY: 'fake' },
      permissionMode: 'approve-for-me',
      disposeGraceMs: 25,
    })

    const invalidCwdParent = {
      id: 'parent-with-invalid-cwd',
      session: { header: { cwd: 'relative/SECRET_TOKEN' } },
    } as unknown as Agent
    const invalidCwdError: unknown = await ctx.subagents.start('codex-diagnostic', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: invalidCwdParent,
      signal: new AbortController().signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(invalidCwdError).toBeInstanceOf(Error)
    if (!(invalidCwdError instanceof Error)) {
      throw new Error('expected safe invalid-cwd failure')
    }
    expect(invalidCwdError.message).toContain(
      expectedFailureDiagnostic('initialize', 'unknown'),
    )
    expect(invalidCwdError.message).not.toContain('relative/SECRET_TOKEN')
    expect(invalidCwdError.cause).toBeInstanceOf(Error)
    expect((invalidCwdError.cause as Error).message)
      .toContain('relative/SECRET_TOKEN')
    expect(spawn).not.toHaveBeenCalled()

    const invalidCwdAbort = new AbortController()
    invalidCwdAbort.abort(new Error('cancel invalid cwd startup'))
    await expect(ctx.subagents.start('codex-diagnostic', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: invalidCwdParent,
      signal: invalidCwdAbort.signal,
    })).rejects.toThrow('aborted before app-server startup')
    expect(spawn).not.toHaveBeenCalled()

    const starting = ctx.subagents.start('codex-diagnostic', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.149.1' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: process.cwd(),
      ephemeral: true,
      model: 'codex-diagnostic-model',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send({
      id: 'provider-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['cancel'],
        command: 'cat /private/secret.txt',
      },
    })
    await child.peer.nextResponse('provider-approval')
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'SECRET_TOKEN in /private/secret.txt',
      codexErrorInfo: 'other',
    }))
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: `${expectedFailureDiagnostic('turn', 'product-error')}\nCodex unattended decision (mode: approve-for-me; request: command approval; decision: cancelled): the provider does not grant interactive approval`,
      stopReason: 'error',
    })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      env: { OPENAI_API_KEY: 'fake' },
      graceMs: 25,
      cwd: process.cwd(),
    }))
    expect(warnings).toEqual([
      expect.stringContaining(
        `subagent-codex "codex-diagnostic": child run failed (error): subagent-codex: ${expectedFailureDiagnostic('turn', 'product-error')}`,
      ),
    ])
    expect(warnings.join('\n')).not.toContain('SECRET_TOKEN')
    expect(warnings.join('\n')).not.toContain('/private/secret.txt')
    await run.dispose()
    await ctx.fiber.dispose()
  })
})

describe('disposeCodexChild', () => {
  it('closes stdin, terminates, and waits for the managed range', async () => {
    const child = fakeChild()
    const wire = defaultWire(child)
    const end = vi.spyOn(child.toChild, 'end')
    await disposeCodexChild(wire, child.handle)
    expect(end).toHaveBeenCalled()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledWith()
  })

  it('does not finish disposal before the managed range is empty', async () => {
    const child = fakeChild({ exitOnTerminate: false })
    const wire = defaultWire(child)
    let disposed = false
    const disposal = disposeCodexChild(wire, child.handle).then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(disposed).toBe(false)
    child.settle()
    await disposal
    expect(disposed).toBe(true)
  })

  it('contains a concurrently closed stdin error', async () => {
    const child = fakeChild()
    const wire = defaultWire(child)
    vi.spyOn(child.toChild, 'end').mockImplementation(() => {
      throw new Error('already closed')
    })
    await expect(disposeCodexChild(wire, child.handle))
      .resolves.toBeUndefined()
  })

  it('still runs idempotent cleanup when target startup rejects', async () => {
    const child = fakeChild({
      doneError: new Error('spawn failed'),
    })
    const wire = defaultWire(child)
    await expect(disposeCodexChild(wire, child.handle))
      .resolves.toBeUndefined()
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('reports range-wait failure with safe teardown facts', async () => {
    const child = fakeChild({
      waitForExitError: new Error('SECRET_TOKEN wait failure'),
    })
    const wire = defaultWire(child)
    const disposal = disposeCodexChild(wire, child.handle)
    await expect(disposal).rejects.toThrow(expectedFailureDiagnostic(
      'teardown',
      'unknown',
      { outcome: { exitCode: 0, signal: null } },
    ))
    await expect(disposal).rejects.not.toThrow('SECRET_TOKEN')
  })

  it('does not wait for a pending process outcome after tree observation fails', async () => {
    const child = fakeChild({
      exitOnTerminate: false,
      waitForExitError: new Error('SECRET_TOKEN wait failure'),
    })
    const wire = defaultWire(child)
    let disposalError: unknown
    const disposal = disposeCodexChild(wire, child.handle).catch(
      (error: unknown) => { disposalError = error },
    )
    await nextTask()
    expect(disposalError).toBeInstanceOf(Error)
    expect(String(disposalError)).toContain(
      expectedFailureDiagnostic('teardown', 'unknown'),
    )
    expect(String(disposalError)).not.toContain('SECRET_TOKEN')
    child.settle()
    await disposal
  })
})
