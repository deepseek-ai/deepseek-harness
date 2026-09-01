import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type {
  Options,
  Query,
  SDKMessage,
  SDKPermissionDeniedMessage,
  SDKResultMessage,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as claudeCode from '../src/index.ts'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
  sdkEnvironmentOverlay,
} from '../src/process.ts'
import {
  CLAUDE_CODE_PERMISSION_MODES,
  DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
  claudeQueryOptions,
  consumeClaudeQuery,
  disposeClaudeCodeChild,
  startClaudeCodeRun,
  successfulResult,
  textTask,
  type ClaudeCodeRunSpec,
} from '../src/run.ts'

type QueryFactory = (params: {
  prompt: string
  options: Options
}) => Query

const queryMock = vi.hoisted(() => vi.fn<QueryFactory>())

const CLAUDE_AGENT_SDK_VERSION = '0.3.241'
const CLAUDE_CODE_VERSION = '2.1.241'
const CLAUDE_PLATFORM_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  '@anthropic-ai/claude-agent-sdk-darwin-x64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
  '@anthropic-ai/claude-agent-sdk-linux-x64',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  '@anthropic-ai/claude-agent-sdk-win32-arm64',
  '@anthropic-ai/claude-agent-sdk-win32-x64',
] as const

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
}))

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

function errorCause(value: unknown): Error | undefined {
  return value instanceof Error && value.cause instanceof Error
    ? value.cause
    : undefined
}

interface FakeChildOptions {
  readonly pid?: number
  readonly exitOnTerminate?: boolean
  readonly waitForExitError?: Error
  readonly doneError?: Error
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly fail: (error: Error) => void
  readonly terminate: Mock<SubprocessHandle['terminate']>
  readonly waitForExit: Mock<SubprocessHandle['waitForExit']>
}

function fakeChild(options: FakeChildOptions = {}): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exited = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // Individual tests deliberately exercise rejected and still-pending handles.
  void done.catch(() => {})
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
  const terminate = vi.fn<SubprocessHandle['terminate']>(() => {
    if (options.exitOnTerminate !== false) settle()
  })
  const waitForExit = vi.fn<SubprocessHandle['waitForExit']>(async (signal?: AbortSignal): Promise<boolean> => {
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
    pid: options.pid ?? 1234,
    stdin,
    stdout,
    stderr: undefined,
    collected: {},
    done,
    terminate,
    waitForExit,
  }
  return {
    handle,
    stdin,
    stdout,
    settle,
    fail,
    terminate,
    waitForExit,
  }
}

function success(
  result = 'answer',
  isError = false,
): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result,
  } as SDKResultMessage
}

type ErrorSubtype = Exclude<SDKResultMessage['subtype'], 'success'>

function failure(
  subtype: ErrorSubtype,
  errors: string[] = ['fixture failure'],
): SDKResultMessage {
  return {
    type: 'result',
    subtype,
    is_error: true,
    errors,
  } as SDKResultMessage
}

function expectedFailureDiagnostic(
  stage: 'query-start' | 'query-run' | 'process' | 'teardown',
  category: string,
  outcome?: Partial<SubprocessOutcome>,
): string {
  const fields = [
    'product: Claude Code',
    `stage: ${stage}`,
    `category: ${category}`,
  ]
  if (outcome?.exitCode !== null && outcome?.exitCode !== undefined) {
    fields.push(`exit code: ${outcome.exitCode}`)
  }
  if (outcome?.signal !== null && outcome?.signal !== undefined) {
    fields.push(`signal: ${outcome.signal}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

function permissionDenied(): SDKPermissionDeniedMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'tool-secret',
    decision_reason_type: 'mode',
    decision_reason: 'contains /private/secret.txt',
    message: 'command with SECRET_TOKEN was denied',
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'session-secret',
  }
}

function queryFrom(
  messages: readonly SDKMessage[],
  after?: Error,
  close = vi.fn(),
): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    for (const message of messages) yield message
    if (after !== undefined) throw after
  }
  return Object.assign(stream(), { close }) as unknown as Query
}

function waitingQuery(signal: AbortSignal, close = vi.fn()): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    await new Promise<never>((_resolve, reject) => {
      const fail = (): void => {
        reject(signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason)))
      }
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
  }
  return Object.assign(stream(), { close }) as unknown as Query
}

function sdkSpawnOptions(
  overrides: Partial<SpawnOptions> = {},
): SpawnOptions {
  return {
    command: '/sdk/claude',
    args: ['--output-format', 'stream-json'],
    cwd: '/workspace',
    env: { PATH: '/bin', OMITTED: undefined },
    signal: new AbortController().signal,
    ...overrides,
  }
}

interface FakeRun {
  readonly child: FakeChild
  readonly close: ReturnType<typeof vi.fn>
  readonly spawnSpecs: SubprocessSpawnSpec[]
  readonly options: Options[]
  readonly spec: ClaudeCodeRunSpec
}

function fakeRun(
  messages: readonly SDKMessage[] = [success()],
  after?: Error,
  child = fakeChild(),
): FakeRun {
  const close = vi.fn()
  const query = queryFrom(messages, after, close)
  const spawnSpecs: SubprocessSpawnSpec[] = []
  const options: FakeRun['options'] = []
  const spec: ClaudeCodeRunSpec = {
    cwd: '/workspace',
    permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    env: { ANTHROPIC_API_KEY: 'fake-key' },
    disposeGraceMs: 5,
    spawn: (spawnSpec) => {
      spawnSpecs.push(spawnSpec)
      return child.handle
    },
  }
  queryMock.mockImplementation((params) => {
    options.push(params.options)
    params.options.spawnClaudeCodeProcess!(sdkSpawnOptions())
    return query
  })
  return { child, close, spawnSpecs, options, spec }
}

beforeEach(() => {
  queryMock.mockImplementation(({ options }) => {
    options.spawnClaudeCodeProcess!(sdkSpawnOptions({
      cwd: options.cwd!,
      env: options.env!,
      signal: options.abortController!.signal,
    }))
    return queryFrom([])
  })
})

afterEach(() => {
  queryMock.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

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
      '@anthropic-ai/claude-agent-sdk',
      CLAUDE_AGENT_SDK_VERSION,
    )
    expect(manifest.dependencies).toHaveProperty(
      '@modelcontextprotocol/sdk',
      '^1.29.0',
    )
    expect(manifest.dependencies).toHaveProperty('zod', '^4.4.3')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-codex')

    const sdkRoot = dirname(fileURLToPath(
      import.meta.resolve('@anthropic-ai/claude-agent-sdk'),
    ))
    const sdkManifest = JSON.parse(readFileSync(
      resolve(sdkRoot, 'package.json'),
      'utf8',
    )) as {
      version: string
      claudeCodeVersion: string
      optionalDependencies: Record<string, string>
    }
    expect(sdkManifest.version).toBe(CLAUDE_AGENT_SDK_VERSION)
    expect(sdkManifest.claudeCodeVersion).toBe(CLAUDE_CODE_VERSION)
    expect(sdkManifest.optionalDependencies).toEqual(Object.fromEntries(
      CLAUDE_PLATFORM_PACKAGES.map(packageName => [
        packageName,
        CLAUDE_AGENT_SDK_VERSION,
      ]),
    ))
    const lockfile = readFileSync(resolve(root, '../../../pnpm-lock.yaml'), 'utf8')
    for (const packageName of CLAUDE_PLATFORM_PACKAGES) {
      expect(lockfile).toContain(
        `  '${packageName}@${CLAUDE_AGENT_SDK_VERSION}':`,
      )
      expect(lockfile).toContain(
        `      '${packageName}': ${CLAUDE_AGENT_SDK_VERSION}`,
      )
    }

    const parsed = yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'))
    const rows = Array.isArray(parsed)
      ? (parsed as Array<{ insert?: Array<{ id?: string; name?: string }> }>).flatMap(entry => entry.insert ?? [])
      : []
    expect(rows).toEqual([{
      id: 'subagent-claude-code',
      name: '@deepseek-ai/dsh-subagent-claude-code',
    }])
    expect(JSON.stringify(rows)).not.toContain('tool-subagent')
  })

  it('preserves text sequences and rejects empty, blank, and non-text tasks', () => {
    expect(textTask([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])).toBe('onetwo')
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
    const fiber = await ctx.plugin(claudeCode, {})
    expect(ctx.subagents.getProvider('claude-code')).toMatchObject({
      name: 'claude-code',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    })
    expect(ctx.subagents.list()).toEqual(['claude-code'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])

    for (const disposeGraceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(ctx.plugin(claudeCode, { disposeGraceMs }))
        .rejects.toThrow('disposeGraceMs must be a positive finite number')
    }
    await expect(ctx.plugin(claudeCode, {
      disposeGraceMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow(
      `disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
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
      return spec.env?.DSH_CLAUDE_INSTANCE === 'safe'
        ? safeChild.handle
        : bypassChild.handle
    })
    const queryOptions: Options[] = []
    queryMock.mockImplementation(({ options }) => {
      queryOptions.push(options)
      options.spawnClaudeCodeProcess!(sdkSpawnOptions({
        cwd: options.cwd!,
        env: options.env!,
        signal: options.abortController!.signal,
      }))
      return options.permissionMode === 'dontAsk'
        ? waitingQuery(options.abortController!.signal)
        : queryFrom([success('bypass answer')])
    })

    const added: string[] = []
    const started: string[] = []
    const ended: string[] = []
    const removed: string[] = []
    ctx.on('subagent/provider-added', provider => void added.push(provider.name))
    ctx.on('subagent/start', info => void started.push(info.provider))
    ctx.on('subagent/end', info => void ended.push(info.provider))
    ctx.on('subagent/provider-removed', providerName => void removed.push(providerName))
    const safeFiber = await ctx.plugin(claudeCode, {
      providerName: 'claude-safe',
      model: 'claude-safe-model',
      env: { DSH_CLAUDE_INSTANCE: 'safe' },
      permissionMode: 'dontAsk',
      disposeGraceMs: 11,
    })
    const bypassFiber = await ctx.plugin(claudeCode, {
      providerName: 'claude-bypass',
      model: 'claude-bypass-model',
      env: { DSH_CLAUDE_INSTANCE: 'bypass' },
      permissionMode: 'bypassPermissions',
      disposeGraceMs: 29,
    })
    expect(ctx.subagents.list()).toEqual(['claude-safe', 'claude-bypass'])
    expect(added).toEqual(['claude-safe', 'claude-bypass'])

    const safeController = new AbortController()
    const [safeRun, bypassRun] = await Promise.all([
      ctx.subagents.start('claude-safe', request(undefined, safeController.signal)),
      ctx.subagents.start('claude-bypass', request()),
    ])
    await safeFiber.dispose()
    expect(ctx.subagents.list()).toEqual(['claude-bypass'])
    expect(removed).toEqual(['claude-safe'])
    await expect(ctx.subagents.start('claude-safe', request()))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })

    await expect(bypassRun.result).resolves.toEqual({
      output: [{ type: 'text', text: 'bypass answer' }],
      stopReason: 'completed',
    })
    safeController.abort(new Error('stop only the safe instance'))
    await expect(safeRun.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    expect(queryOptions.map(options => ({
      instance: options.env?.DSH_CLAUDE_INSTANCE,
      model: options.model,
      permissionMode: options.permissionMode,
    }))).toEqual([
      { instance: 'safe', model: 'claude-safe-model', permissionMode: 'dontAsk' },
      { instance: 'bypass', model: 'claude-bypass-model', permissionMode: 'bypassPermissions' },
    ])
    expect(spawnSpecs.map(spec => ({
      instance: spec.env?.DSH_CLAUDE_INSTANCE,
      graceMs: spec.graceMs,
    }))).toEqual([
      { instance: 'safe', graceMs: 11 },
      { instance: 'bypass', graceMs: 29 },
    ])

    await Promise.all([safeRun.dispose(), bypassRun.dispose()])
    expect([...started].sort()).toEqual(['claude-bypass', 'claude-safe'])
    expect([...ended].sort()).toEqual(['claude-bypass', 'claude-safe'])
    expect(safeChild.terminate).toHaveBeenCalledOnce()
    expect(bypassChild.terminate).toHaveBeenCalledOnce()
    await bypassFiber.dispose()
    expect(removed).toEqual(['claude-safe', 'claude-bypass'])
    await ctx.fiber.dispose()
  })

  it('rejects duplicate provider names without replacing the first instance', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const firstFiber = await ctx.plugin(claudeCode, {
      providerName: 'claude-duplicate',
    })
    const first = ctx.subagents.getProvider('claude-duplicate')
    await expect(ctx.plugin(claudeCode, {
      providerName: 'claude-duplicate',
      permissionMode: 'bypassPermissions',
    })).rejects.toMatchObject({ code: 'DUPLICATE_PROVIDER' })
    expect(ctx.subagents.getProvider('claude-duplicate')).toBe(first)
    expect(ctx.subagents.list()).toEqual(['claude-duplicate'])
    await firstFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('accepts an optional non-empty model and the five fixed permission modes', () => {
    expect(claudeCode.Config({}).providerName).toBe('claude-code')
    expect(claudeCode.Config({}).model).toBeUndefined()
    expect(claudeCode.Config({ providerName: 'claude-safe' }).providerName)
      .toBe('claude-safe')
    expect(() => claudeCode.Config({ providerName: '' })).toThrow()
    expect(claudeCode.Config({ model: 'claude-opus' }).model).toBe('claude-opus')
    expect(() => claudeCode.Config({ model: '' })).toThrow()
    expect(claudeCode.Config({}).permissionMode)
      .toBe(DEFAULT_CLAUDE_CODE_PERMISSION_MODE)
    for (const permissionMode of CLAUDE_CODE_PERMISSION_MODES) {
      expect(claudeCode.Config({ permissionMode }).permissionMode)
        .toBe(permissionMode)
    }
    for (const permissionMode of ['default', 'interactive', 'future-mode']) {
      expect(() => claudeCode.Config({ permissionMode } as never)).toThrow()
    }
  })

  it('resolves the safe permission default when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const child = fakeChild()
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
    queryMock.mockImplementation(({ options }) => {
      expect(options).not.toHaveProperty('model')
      expect(options.permissionMode).toBe(DEFAULT_CLAUDE_CODE_PERMISSION_MODE)
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      return queryFrom([success('native model answer')])
    })
    claudeCode.apply(ctx, { env: {}, disposeGraceMs: 3_000 })
    expect(ctx.subagents.getProvider('claude-code')).toBeDefined()
    const run = await ctx.subagents.start('claude-code', request())
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'native model answer' }],
      stopReason: 'completed',
    })
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('starts through the registered provider with its resolved config and diagnostics', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const child = fakeChild()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      .mockImplementation(() => child.handle)
    const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable')
      .mockResolvedValue('/host/bin/claude')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(claudeCode, {
      providerName: 'claude-diagnostic',
      model: 'claude-diagnostic-model',
      env: {
        ANTHROPIC_API_KEY: 'provider-fake-key',
        CLAUDE_CONFIG_DIR: '/private/tmp/dsh-claude-code-unit-config',
        HOME: '/private/tmp/dsh-claude-code-unit-home',
      },
      permissionMode: 'auto',
      disposeGraceMs: 29,
    })

    await expect(ctx.subagents.start('claude-diagnostic', {
      ...request(),
      parent: {
        id: 'parent-without-cwd',
        session: { header: {} },
      } as unknown as Agent,
    })).rejects.toThrow(
      'subagent-claude-code: no working directory for the child — delegate from a parent session that has one',
    )
    expect(queryMock).not.toHaveBeenCalled()

    const invalidCwdParent = {
      id: 'parent-with-invalid-cwd',
      session: { header: { cwd: 'relative/SECRET_TOKEN' } },
    } as unknown as Agent
    const invalidCwd = ctx.subagents.start('claude-diagnostic', {
      ...request(),
      parent: invalidCwdParent,
    })
    await expect(invalidCwd)
      .rejects.toThrow(expectedFailureDiagnostic('query-start', 'unknown'))
    await expect(invalidCwd).rejects.not.toThrow('relative/SECRET_TOKEN')
    expect(warn).toHaveBeenCalledWith(
      'subagent-claude-code "claude-diagnostic": child start failed: %o',
      expect.any(Error),
    )
    expect(errorCause(warn.mock.calls[0]?.[1] as unknown)?.message)
      .toContain('relative/SECRET_TOKEN')

    const invalidCwdAbort = new AbortController()
    invalidCwdAbort.abort(new Error('cancel invalid cwd startup'))
    await expect(ctx.subagents.start('claude-diagnostic', {
      ...request(undefined, invalidCwdAbort.signal),
      parent: invalidCwdParent,
    })).rejects.toThrow('aborted before SDK startup')
    expect(queryMock).not.toHaveBeenCalled()
    warn.mockClear()

    vi.stubEnv('PATH', '/host/bin')
    queryMock.mockImplementationOnce(() => {
      throw new Error(
        'Native CLI binary for fixture-platform not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.',
      )
    })
    const missingPayload = ctx.subagents.start('claude-diagnostic', request())
    await expect(missingPayload)
      .rejects.toThrow(expectedFailureDiagnostic('query-start', 'unknown'))
    await expect(missingPayload).rejects.not.toThrow('Native CLI binary')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'subagent-claude-code "claude-diagnostic": child run failed (error):',
      ),
      expect.any(Error),
    )
    expect(errorCause(warn.mock.calls[0]?.[1] as unknown)?.message)
      .toContain('Native CLI binary for fixture-platform not found')
    expect(resolveExecutable).not.toHaveBeenCalled()

    const run = await ctx.subagents.start('claude-diagnostic', request())
    child.settle({ exitCode: 9, signal: null })
    child.stdout.end()
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: expectedFailureDiagnostic('query-run', 'invalid-result'),
      stopReason: 'error',
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'subagent-claude-code "claude-diagnostic": child run failed (error):',
      ),
      expect.any(Error),
    )
    expect(resolveExecutable).not.toHaveBeenCalled()
    expect(queryMock.mock.calls[1]?.[0].options)
      .not.toHaveProperty('pathToClaudeCodeExecutable')
    expect(queryMock.mock.calls[1]?.[0].options.permissionMode).toBe('auto')
    expect(queryMock.mock.calls[1]?.[0].options.model)
      .toBe('claude-diagnostic-model')
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(),
      graceMs: 29,
    }))
    expect(spawn.mock.calls[0]?.[0].env).toMatchObject({
      ANTHROPIC_API_KEY: 'provider-fake-key',
    })
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps the Loader namespace shape', () => {
    expect('default' in claudeCode).toBe(false)
    expect(claudeCode.name).toBe('subagent-claude-code')
    expect(claudeCode.inject).toEqual(['subagents', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(claudeCode)).toBe(claudeCode)
  })
})

describe('official spawn projection', () => {
  it('forwards command, arguments, cwd, environment, and signal exactly', () => {
    vi.stubEnv('SDK_REMOVED_AMBIENT', 'ambient-value')
    const signal = new AbortController().signal
    const options = sdkSpawnOptions({
      command: '/official/claude',
      args: ['--one', 'two'],
      cwd: '/parent/workspace',
      env: { A: 'one', B: undefined, C: 'three' },
      signal,
    })
    expect(sdkEnvironmentOverlay(options.env)).toEqual(expect.objectContaining({
      A: 'one',
      B: undefined,
      C: 'three',
      SDK_REMOVED_AMBIENT: undefined,
    }))
    const spawnSpec = claudeSpawnSpec(options, 321)
    expect(spawnSpec).toMatchObject({
      argv: ['/official/claude', '--one', 'two'],
      cwd: '/parent/workspace',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 321,
      signal,
    })
    expect(spawnSpec.env).toEqual(expect.objectContaining({
      A: 'one',
      B: undefined,
      C: 'three',
      SDK_REMOVED_AMBIENT: undefined,
    }))
    const missingCwd = sdkSpawnOptions()
    delete missingCwd.cwd
    expect(() => claudeSpawnSpec(
      missingCwd,
      321,
    )).toThrow('SDK spawn request omitted its workspace')
    expect(() => claudeSpawnSpec(
      sdkSpawnOptions({ cwd: '' }),
      321,
    )).toThrow('SDK spawn request omitted its workspace')
  })

  it('forwards the SDK-selected Windows native executable without a batch shim', () => {
    const command = String.raw`C:\Program Files\Claude\claude.exe`
    const spec = claudeSpawnSpec(sdkSpawnOptions({
      command,
      args: ['--output-format', 'stream-json'],
    }), 7)

    expect(spec.argv).toEqual([
      command, '--output-format', 'stream-json',
    ])
  })

  it('projects streams, exit facts, listeners, and idempotent tree termination', async () => {
    const child = fakeChild({ exitOnTerminate: false })
    const process = new ManagedClaudeCodeProcess(child.handle)
    expect(process.stdin).toBe(child.stdin)
    expect(process.stdout).toBe(child.stdout)
    expect(process.killed).toBe(false)
    expect(process.exitCode).toBeNull()
    expect(process.signalCode).toBeNull()
    expect(process.outcome).toBeUndefined()

    const exit = vi.fn()
    const once = vi.fn()
    const removed = vi.fn()
    process.on('exit', exit)
    process.once('exit', once)
    process.on('exit', removed)
    process.off('exit', removed)
    expect(process.kill('SIGTERM')).toBe(true)
    expect(process.killed).toBe(true)
    expect(process.kill('SIGKILL')).toBe(false)
    expect(child.terminate).toHaveBeenCalledOnce()

    child.settle({ exitCode: null, signal: 'SIGTERM' })
    await nextTask()
    expect(exit).toHaveBeenCalledWith(null, 'SIGTERM')
    expect(once).toHaveBeenCalledOnce()
    expect(removed).not.toHaveBeenCalled()
    expect(process.signalCode).toBe('SIGTERM')
    expect(process.outcome).toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(process.kill('SIGTERM')).toBe(false)
  })

  it('emits spawn errors', async () => {
    const child = fakeChild({ pid: -1 })
    const process = new ManagedClaudeCodeProcess(child.handle)
    const errorListener = vi.fn()
    const removed = vi.fn()
    process.once('error', errorListener)
    process.on('error', removed)
    process.off('error', removed)
    child.fail(new Error('spawn boom'))
    await nextTask()
    expect(errorListener).toHaveBeenCalledWith(expect.objectContaining({
      message: 'spawn boom',
    }))
    expect(removed).not.toHaveBeenCalled()
  })

  it('exposes a settled direct-child exit code', async () => {
    const child = fakeChild()
    const process = new ManagedClaudeCodeProcess(child.handle)
    child.settle({ exitCode: 7, signal: null })
    await nextTask()
    expect(process.exitCode).toBe(7)
    expect(process.signalCode).toBeNull()
    expect(process.outcome).toEqual({ exitCode: 7, signal: null })
    expect(process.kill('SIGTERM')).toBe(false)
  })
})

describe('query options and result mapping', () => {
  it('builds the fixed unattended options over the scrubbed environment', async () => {
    vi.stubEnv('HOST_VISIBLE', 'visible')
    vi.stubEnv('HOST_SECRET_TOKEN', 'must-not-leak')
    vi.stubEnv('DSH_INTERNAL', 'must-not-leak')
    const child = fakeChild()
    const spawn = vi.fn(() => child.handle)
    const captured: SubprocessHandle[] = []
    const diagnostics: string[] = []
    const spec: ClaudeCodeRunSpec = {
      cwd: '/workspace',
      model: 'claude-explicit-model',
      permissionMode: 'acceptEdits',
      env: {
        HOST_VISIBLE: 'overridden',
        ANTHROPIC_API_KEY: 'explicit-fake-key',
      },
      disposeGraceMs: 17,
      spawn,
    }
    const controller = new AbortController()
    const options = claudeQueryOptions(
      spec,
      controller,
      (value) => {
        captured.push(value)
      },
      value => diagnostics.push(value),
    )

    expect(options).toMatchObject({
      abortController: controller,
      cwd: '/workspace',
      model: 'claude-explicit-model',
      persistSession: false,
      disallowedTools: ['AskUserQuestion'],
      permissionMode: 'acceptEdits',
      supportedDialogKinds: ['refusal_fallback_prompt'],
    })
    expect(options).not.toHaveProperty('pathToClaudeCodeExecutable')
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect(options.env).toMatchObject({
      HOST_VISIBLE: 'overridden',
      ANTHROPIC_API_KEY: 'explicit-fake-key',
    })
    expect(options.env).not.toHaveProperty('HOST_SECRET_TOKEN')
    expect(options.env).not.toHaveProperty('DSH_INTERNAL')
    expect(options).not.toHaveProperty('settingSources')

    const callbackSignal = new AbortController().signal
    await expect(options.canUseTool!(
      'Bash',
      { command: 'cat /private/secret.txt', token: 'SECRET_TOKEN' },
      {
        signal: callbackSignal,
        toolUseID: 'tool-1',
        requestId: 'request-1',
        blockedPath: '/private/secret.txt',
        decisionReason: 'SECRET_TOKEN in /private/secret.txt',
      },
    )).resolves.toEqual({
      behavior: 'deny',
      message: 'This unattended Claude Code subagent cannot request human approval.',
    })
    await expect(options.onElicitation!(
      {
        serverName: 'private-server',
        message: 'enter SECRET_TOKEN',
        requestedSchema: { secret: true },
      },
      { signal: callbackSignal, requestId: 'request-2' },
    )).resolves.toEqual({ action: 'decline' })
    await expect(options.onUserDialog!(
      {
        dialogKind: 'refusal_fallback_prompt',
        payload: { path: '/private/secret.txt', token: 'SECRET_TOKEN' },
      },
      { signal: callbackSignal, requestId: 'request-3' },
    )).resolves.toEqual({ behavior: 'cancelled' })
    expect(diagnostics).toEqual([
      'Claude Code unattended decision (mode: acceptEdits; request: tool permission; decision: denied): the provider does not request human approval',
      'Claude Code unattended decision (mode: acceptEdits; request: MCP elicitation; decision: declined): the provider does not collect interactive MCP input',
      'Claude Code unattended decision (mode: acceptEdits; request: user dialog; decision: cancelled): the provider does not render blocking dialogs',
    ])
    expect(diagnostics.join('\n')).not.toContain('SECRET_TOKEN')
    expect(diagnostics.join('\n')).not.toContain('/private/secret.txt')

    const spawned = options.spawnClaudeCodeProcess!(sdkSpawnOptions())
    expect(spawned).toBeInstanceOf(ManagedClaudeCodeProcess)
    expect(captured).toEqual([child.handle])
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['/sdk/claude', '--output-format', 'stream-json'],
      cwd: '/workspace',
      graceMs: 17,
    }))
  })

  it.each(CLAUDE_CODE_PERMISSION_MODES)(
    'maps the %s mode and only confirms the dangerous bypass',
    (permissionMode) => {
      const child = fakeChild()
      const options = claudeQueryOptions({
        cwd: '/workspace',
        permissionMode,
        env: {},
        disposeGraceMs: 17,
        spawn: () => child.handle,
      }, new AbortController(), () => {}, () => {})
      expect(options.permissionMode).toBe(permissionMode)
      expect(options).not.toHaveProperty('model')
      expect(options.disallowedTools).toEqual(permissionMode === 'plan'
        ? ['AskUserQuestion', 'ExitPlanMode']
        : ['AskUserQuestion'])
      if (permissionMode === 'bypassPermissions') {
        expect(options.allowDangerouslySkipPermissions).toBe(true)
        expect(options).not.toHaveProperty('canUseTool')
      } else {
        expect(options).not.toHaveProperty('allowDangerouslySkipPermissions')
        expect(options.canUseTool).toBeTypeOf('function')
      }
    },
  )

  it('disallows ExitPlanMode before native plan-mode allow rules', () => {
    const child = fakeChild()
    const options = claudeQueryOptions({
      cwd: '/workspace',
      permissionMode: 'plan',
      env: {},
      disposeGraceMs: 17,
      spawn: () => child.handle,
    }, new AbortController(), () => {}, () => {})
    expect(options.disallowedTools).toEqual([
      'AskUserQuestion',
      'ExitPlanMode',
    ])
  })

  it('accepts only a non-error success with a non-blank final result', () => {
    expect(successfulResult(success('exact final'))).toBe('exact final')
    expect(() => successfulResult(success('answer', true)))
      .toThrow(expectedFailureDiagnostic('query-run', 'invalid-result'))
    expect(() => successfulResult(success(' \n ')))
      .toThrow(expectedFailureDiagnostic('query-run', 'invalid-result'))
    const sdkFailure = () => successfulResult(failure(
      'error_during_execution',
      ['SECRET_TOKEN', '/private/secret.txt'],
    ))
    expect(sdkFailure).toThrow(expectedFailureDiagnostic(
      'query-run',
      'product-error',
    ))
    expect(sdkFailure).not.toThrow('SECRET_TOKEN')
    expect(sdkFailure).not.toThrow('/private/secret.txt')
    expect(() => successfulResult(failure(
      'error_max_turns',
      [],
    ))).toThrow(expectedFailureDiagnostic('query-run', 'limit'))

    const unknown = {
      type: 'result',
      subtype: 'future_failure',
      is_error: true,
      errors: ['SECRET_TOKEN'],
    } as unknown as SDKResultMessage
    expect(() => successfulResult(unknown))
      .toThrow(expectedFailureDiagnostic('query-run', 'unknown'))
    expect(() => successfulResult(unknown)).not.toThrow('future_failure')
    expect(() => successfulResult(unknown)).not.toThrow('SECRET_TOKEN')
  })

  it('consumes the complete stream and keeps the latest strict success', async () => {
    const query = queryFrom([
      { type: 'system', subtype: 'init' } as SDKMessage,
      success('first'),
      success('last'),
    ])
    await expect(consumeClaudeQuery(query)).resolves.toEqual({
      output: [{ type: 'text', text: 'last' }],
      stopReason: 'completed',
    })
    await expect(consumeClaudeQuery(
      queryFrom([{ type: 'system', subtype: 'init' } as SDKMessage]),
    )).rejects.toThrow(expectedFailureDiagnostic('query-run', 'invalid-result'))

    const onPermissionDenied = vi.fn()
    await expect(consumeClaudeQuery(queryFrom([
      permissionDenied(),
      success('after denial'),
    ]), onPermissionDenied)).resolves.toEqual({
      output: [{ type: 'text', text: 'after denial' }],
      stopReason: 'completed',
    })
    expect(onPermissionDenied).toHaveBeenCalledOnce()
  })
})

describe('run publication, cancellation, and settlement', () => {
  it('publishes only after Query and managed child exist, then disposes once', async () => {
    const fixture = fakeRun([success('exact answer')])
    const run = await startClaudeCodeRun(
      request([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
      fixture.spec,
    )
    expect(fixture.options).toHaveLength(1)
    expect(fixture.spawnSpecs).toHaveLength(1)
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'exact answer' }],
      stopReason: 'completed',
    })
    const first = run.dispose()
    const second = run.dispose()
    expect(second).toBe(first)
    await first
    expect(fixture.close).toHaveBeenCalledOnce()
    expect(fixture.child.terminate).toHaveBeenCalledOnce()
  })

  it('groups SDK errors by parent-action category without changing stop reasons', async () => {
    const cases: Array<readonly [ErrorSubtype, string]> = [
      ['error_during_execution', 'product-error'],
      ['error_max_turns', 'limit'],
      ['error_max_budget_usd', 'limit'],
      ['error_max_structured_output_retries', 'limit'],
    ]
    for (const [subtype, category] of cases) {
      const fixture = fakeRun([failure(subtype)])
      const onError = vi.fn()
      const run = await startClaudeCodeRun(
        request(),
        { ...fixture.spec, onError },
      )
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedFailureDiagnostic('query-run', category),
        stopReason: 'error',
      })
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        'error',
      )
      await run.dispose()
    }
  })

  it('attaches a safe diagnostic when a permission denial precedes failure', async () => {
    const fixture = fakeRun([
      permissionDenied(),
      failure('error_during_execution'),
    ])
    const run = await startClaudeCodeRun(request(), fixture.spec)
    const result = await run.result
    expect(result).toEqual({
      output: [],
      diagnostic: `${expectedFailureDiagnostic('query-run', 'product-error')}\nClaude Code unattended decision (mode: dontAsk; request: tool permission; decision: denied): Claude Code denied the request before an interactive prompt`,
      stopReason: 'error',
    })
    expect(result.diagnostic).not.toContain('SECRET_TOKEN')
    expect(result.diagnostic).not.toContain('/private/secret.txt')
    await run.dispose()
  })

  it('omits captured diagnostics on success and isolates concurrent runs', async () => {
    const children = [fakeChild(), fakeChild()]
    let childIndex = 0
    const spec: ClaudeCodeRunSpec = {
      cwd: '/workspace',
      permissionMode: 'dontAsk',
      env: {},
      disposeGraceMs: 5,
      spawn: () => children[childIndex++]!.handle,
    }
    queryMock.mockImplementation(({ prompt, options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      return prompt === 'denied then completed'
        ? queryFrom([permissionDenied(), success('completed answer')])
        : queryFrom([failure('error_during_execution')])
    })

    const [completed, failed] = await Promise.all([
      startClaudeCodeRun(
        request([{ type: 'text', text: 'denied then completed' }]),
        spec,
      ),
      startClaudeCodeRun(
        request([{ type: 'text', text: 'unrelated failure' }]),
        spec,
      ),
    ])
    await expect(completed.result).resolves.toEqual({
      output: [{ type: 'text', text: 'completed answer' }],
      stopReason: 'completed',
    })
    await expect(failed.result).resolves.toEqual({
      output: [],
      diagnostic: expectedFailureDiagnostic(
        'query-run',
        'product-error',
      ),
      stopReason: 'error',
    })
    await Promise.all([completed.dispose(), failed.dispose()])
  })

  it('fails closed when iteration rejects after a result', async () => {
    const child = fakeChild()
    const outcome = { exitCode: 31, signal: null } as const
    async function* stream(): AsyncGenerator<SDKMessage, void> {
      yield success('partial final')
      child.settle(outcome)
      await Promise.resolve()
      throw new Error('iterator boom')
    }
    queryMock.mockImplementation(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      return Object.assign(stream(), { close: vi.fn() }) as unknown as Query
    })
    const run = await startClaudeCodeRun(request(), {
      cwd: '/workspace',
      permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
      env: {},
      disposeGraceMs: 5,
      spawn: () => child.handle,
    })
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: expectedFailureDiagnostic('query-run', 'unknown', outcome),
      stopReason: 'error',
    })
    await run.dispose()
  })

  it('maps invalid success and missing result to fixed query-run facts', async () => {
    for (const [messages, category] of [
      [[success('answer', true)], 'invalid-result'],
      [[success('')], 'invalid-result'],
      [[{ type: 'system', subtype: 'init' } as SDKMessage], 'invalid-result'],
    ] as const) {
      const fixture = fakeRun(messages)
      const run = await startClaudeCodeRun(request(), fixture.spec)
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedFailureDiagnostic('query-run', category),
        stopReason: 'error',
      })
      await run.dispose()
    }
  })

  it('reports an early process exit with independent code and signal facts', async () => {
    const outcomes: SubprocessOutcome[] = [
      { exitCode: 23, signal: null },
      { exitCode: null, signal: 'SIGABRT' },
      { exitCode: null, signal: null },
    ]
    for (const outcome of outcomes) {
      const child = fakeChild()
      async function* stream(): AsyncGenerator<SDKMessage, void> {
        child.settle(outcome)
        await Promise.resolve()
        throw new Error('SECRET_TOKEN from process transport')
      }
      queryMock.mockImplementation(({ options }) => {
        options.spawnClaudeCodeProcess!(sdkSpawnOptions())
        return Object.assign(stream(), { close: vi.fn() }) as unknown as Query
      })
      const run = await startClaudeCodeRun(request(), {
        cwd: '/workspace',
        permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
        env: {},
        disposeGraceMs: 5,
        spawn: () => child.handle,
      })
      const result = await run.result
      expect(result).toEqual({
        output: [],
        diagnostic: expectedFailureDiagnostic(
          'process',
          'process',
          outcome,
        ),
        stopReason: 'error',
      })
      expect(result.diagnostic).not.toContain('SECRET_TOKEN')
      await run.dispose()
    }
  })

  it('gives local cancellation precedence and isolates overlapping controllers', async () => {
    const firstChild = fakeChild()
    const secondChild = fakeChild()
    const children = [firstChild, secondChild]
    const controllers: AbortController[] = []
    let index = 0
    const spec: ClaudeCodeRunSpec = {
      cwd: '/workspace',
      permissionMode: 'dontAsk',
      env: {},
      disposeGraceMs: 5,
      spawn: () => children[index++]!.handle,
    }
    queryMock.mockImplementation(({ prompt, options }) => {
      controllers.push(options.abortController!)
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      return prompt === 'wait'
        ? waitingQuery(options.abortController!.signal)
        : queryFrom([success('second answer')])
    })
    const firstAbort = new AbortController()
    const first = await startClaudeCodeRun(
      request([{ type: 'text', text: 'wait' }], firstAbort.signal),
      spec,
    )
    const second = await startClaudeCodeRun(
      request([{ type: 'text', text: 'finish' }]),
      spec,
    )
    expect(controllers).toHaveLength(2)
    expect(controllers[0]).not.toBe(controllers[1])
    firstAbort.abort(new Error('parent cancelled'))
    await expect(first.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    await expect(second.result).resolves.toEqual({
      output: [{ type: 'text', text: 'second answer' }],
      stopReason: 'completed',
    })
    expect(controllers[1]!.signal.aborted).toBe(false)
    await Promise.all([first.dispose(), second.dispose()])
  })

  it('keeps local cancellation authoritative when the SDK iterator ends normally', async () => {
    const parentAbort = new AbortController()
    const child = fakeChild()
    async function* stream(): AsyncGenerator<SDKMessage, void> {
      yield success('candidate answer')
      parentAbort.abort(new Error('parent cancelled at iterator completion'))
    }
    queryMock.mockImplementation(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      return Object.assign(stream(), { close: vi.fn() }) as unknown as Query
    })
    const run = await startClaudeCodeRun(
      request(undefined, parentAbort.signal),
      {
        cwd: '/workspace',
        permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
        env: {},
        disposeGraceMs: 5,
        spawn: () => child.handle,
      },
    )
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    await run.dispose()
  })

  it('rejects pre-abort and every incomplete startup transaction', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const unused = fakeRun()
    await expect(startClaudeCodeRun(
      request(undefined, preAborted.signal),
      unused.spec,
    )).rejects.toThrow('aborted before SDK startup')
    expect(unused.options).toEqual([])

    const noChildClose = vi.fn()
    queryMock.mockImplementationOnce(
      () => queryFrom([], undefined, noChildClose),
    )
    await expect(startClaudeCodeRun(request(), {
      ...unused.spec,
    })).rejects.toThrow(expectedFailureDiagnostic('query-start', 'unknown'))
    expect(noChildClose).toHaveBeenCalledOnce()

    const closeFailure = vi.fn(() => { throw new Error('close boom') })
    queryMock.mockImplementationOnce(
      () => queryFrom([], undefined, closeFailure),
    )
    const noChild = startClaudeCodeRun(request(), {
      ...unused.spec,
    })
    await expect(noChild)
      .rejects.toThrow(expectedFailureDiagnostic('query-start', 'unknown'))
    await expect(noChild).rejects.toThrow(
      `${expectedFailureDiagnostic('query-start', 'unknown')}; subagent-claude-code: ${expectedFailureDiagnostic('teardown', 'unknown')}`,
    )
    await expect(noChild).rejects.toBeInstanceOf(AggregateError)

    const startupAbort = new AbortController()
    const abortedChild = fakeChild()
    const abortedClose = vi.fn()
    queryMock.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      startupAbort.abort(new Error('startup cancelled'))
      return queryFrom([], undefined, abortedClose)
    })
    const abortedDuringStartup = startClaudeCodeRun(
      request(undefined, startupAbort.signal),
      {
        ...unused.spec,
        spawn: () => abortedChild.handle,
      },
    )
    await expect(abortedDuringStartup)
      .rejects.toThrow('aborted before SDK startup')
    expect(abortedClose).toHaveBeenCalledOnce()
    expect(abortedChild.terminate).toHaveBeenCalledOnce()

    const cleanupAbort = new AbortController()
    const cleanupFailedChild = fakeChild({
      waitForExitError: new Error('SECRET_TOKEN cleanup wait failure'),
    })
    queryMock.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      cleanupAbort.abort(new Error('startup cancelled'))
      return queryFrom([])
    })
    const cancelledCleanupFailure = startClaudeCodeRun(
      request(undefined, cleanupAbort.signal),
      {
        ...unused.spec,
        spawn: () => cleanupFailedChild.handle,
      },
    )
    await expect(cancelledCleanupFailure)
      .rejects.toBeInstanceOf(AggregateError)
    await expect(cancelledCleanupFailure)
      .rejects.toThrow(expectedFailureDiagnostic('query-start', 'unknown'))
    await expect(cancelledCleanupFailure).rejects.toThrow(
      `${expectedFailureDiagnostic('query-start', 'unknown')}; subagent-claude-code: ${expectedFailureDiagnostic('teardown', 'unknown', { exitCode: 0, signal: null })}`,
    )
    await expect(cancelledCleanupFailure)
      .rejects.not.toThrow('SECRET_TOKEN')

    queryMock.mockImplementationOnce(() => {
      throw new Error('query failed before resource creation')
    })
    const queryFailureOnError = vi.fn<
      NonNullable<ClaudeCodeRunSpec['onError']>
    >()
    const queryFailure = startClaudeCodeRun(request(), {
      ...unused.spec,
      onError: queryFailureOnError,
    })
    await expect(queryFailure)
      .rejects.toThrow(expectedFailureDiagnostic('query-start', 'unknown'))
    await expect(queryFailure).rejects.not.toThrow(
      'query failed before resource creation',
    )
    expect(queryFailureOnError).toHaveBeenCalledWith(
      expect.any(Error),
      'error',
    )
    expect(errorCause(queryFailureOnError.mock.calls[0]?.[0])?.message)
      .toBe('query failed before resource creation')

    const spawned = fakeChild()
    const spawnSpecs: SubprocessSpawnSpec[] = []
    let factoryController: AbortController | undefined
    queryMock.mockImplementationOnce(({ options }) => {
      factoryController = options.abortController
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      spawned.settle({ exitCode: 17, signal: null })
      throw new Error('query construction failed')
    })
    const factoryFailure = startClaudeCodeRun(request(), {
      ...unused.spec,
      spawn: (spawnSpec) => {
        spawnSpecs.push(spawnSpec)
        return spawned.handle
      },
    })
    await expect(factoryFailure).rejects.toThrow(expectedFailureDiagnostic(
      'query-start',
      'unknown',
      { exitCode: 17, signal: null },
    ))
    await expect(factoryFailure).rejects.not.toThrow('query construction failed')
    expect(spawnSpecs).toHaveLength(1)
    expect(factoryController?.signal.aborted).toBe(true)
    expect(spawned.terminate).toHaveBeenCalledOnce()

    const cleanupRaceAbort = new AbortController()
    const cleanupRaceChild = fakeChild({ exitOnTerminate: false })
    queryMock.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      throw new Error('query failed before cleanup wait')
    })
    const cleanupRace = startClaudeCodeRun(
      request(undefined, cleanupRaceAbort.signal),
      {
        ...unused.spec,
        spawn: () => cleanupRaceChild.handle,
      },
    )
    await nextTask()
    cleanupRaceAbort.abort(new Error('cancelled during cleanup'))
    cleanupRaceChild.settle()
    await expect(cleanupRace).rejects.toThrow('aborted before SDK startup')

    const spawnError = Object.assign(
      new Error('spawn /sdk/claude EACCES'),
      { code: 'EACCES', path: '/sdk/claude' },
    )
    const failedSpawn = fakeChild({
      pid: -1,
      doneError: spawnError,
    })
    const failed = fakeRun([], undefined, failedSpawn)
    const failedStartup = startClaudeCodeRun(request(), failed.spec)
    await expect(failedStartup)
      .rejects.toThrow(expectedFailureDiagnostic('query-start', 'unknown'))
    await expect(failedStartup).rejects.not.toThrow('spawn /sdk/claude EACCES')
    await expect(failedStartup).rejects.toMatchObject({ cause: spawnError })
    expect(failed.close).toHaveBeenCalledOnce()
    expect(failedSpawn.terminate).not.toHaveBeenCalled()
    expect(failedSpawn.waitForExit).not.toHaveBeenCalled()

    const failedSpawnAbort = new AbortController()
    const cancelledFailedSpawn = fakeChild({
      pid: -1,
      doneError: spawnError,
    })
    const cancelledFailedClose = vi.fn()
    queryMock.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      failedSpawnAbort.abort(new Error('startup cancelled'))
      return queryFrom([], undefined, cancelledFailedClose)
    })
    await expect(startClaudeCodeRun(
      request(undefined, failedSpawnAbort.signal),
      { ...unused.spec, spawn: () => cancelledFailedSpawn.handle },
    )).rejects.toThrow('aborted before SDK startup')
    expect(cancelledFailedClose).toHaveBeenCalledOnce()

    const cancelledFailedSpawnCloseError = new Error('cancelled query close failed')
    const cancelledFailedSpawnClose = vi.fn(() => {
      throw cancelledFailedSpawnCloseError
    })
    const cancelledFailedSpawnWithCloseFailure = fakeChild({
      pid: -1,
      doneError: spawnError,
    })
    const failedSpawnAbortWithCloseFailure = new AbortController()
    queryMock.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      failedSpawnAbortWithCloseFailure.abort(new Error('startup cancelled'))
      return queryFrom([], undefined, cancelledFailedSpawnClose)
    })
    const cancelledWithCloseFailure = startClaudeCodeRun(
      request(undefined, failedSpawnAbortWithCloseFailure.signal),
      { ...unused.spec, spawn: () => cancelledFailedSpawnWithCloseFailure.handle },
    )
    await expect(cancelledWithCloseFailure).rejects.toMatchObject({
      message: `subagent-claude-code: ${expectedFailureDiagnostic('query-start', 'unknown')}; subagent-claude-code: ${expectedFailureDiagnostic('teardown', 'unknown')}`,
      errors: [
        expect.objectContaining({
          message: `subagent-claude-code: ${expectedFailureDiagnostic('query-start', 'unknown')}`,
          cause: spawnError,
        }),
        expect.objectContaining({
          message: `subagent-claude-code: ${expectedFailureDiagnostic('teardown', 'unknown')}`,
          cause: cancelledFailedSpawnCloseError,
        }),
      ],
    })
    await expect(cancelledWithCloseFailure)
      .rejects.not.toThrow('spawn /sdk/claude EACCES')
    expect(cancelledFailedSpawnClose).toHaveBeenCalledOnce()

    const failedSpawnCloseError = new Error('query close failed')
    const failedSpawnClose = vi.fn(() => { throw failedSpawnCloseError })
    const failedSpawnWithCloseFailure = fakeChild({
      pid: -1,
      doneError: spawnError,
    })
    queryMock.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      return queryFrom([], undefined, failedSpawnClose)
    })
    const failedWithCloseFailure = startClaudeCodeRun(request(), {
      ...unused.spec,
      spawn: () => failedSpawnWithCloseFailure.handle,
    })
    await expect(failedWithCloseFailure)
      .rejects.toThrow(expectedFailureDiagnostic('query-start', 'unknown'))
    await expect(failedWithCloseFailure)
      .rejects.not.toThrow('spawn /sdk/claude EACCES')
    await expect(failedWithCloseFailure).rejects.toMatchObject({
      message: `subagent-claude-code: ${expectedFailureDiagnostic('query-start', 'unknown')}; subagent-claude-code: ${expectedFailureDiagnostic('teardown', 'unknown')}`,
      errors: [
        expect.objectContaining({ cause: spawnError }),
        expect.objectContaining({ cause: failedSpawnCloseError }),
      ],
    })

    const cleanupError = new Error('live child cleanup failed')
    const constructionError = new Error(
      'query construction failed with a live child',
    )
    const liveChildCleanupFailure = fakeChild({ waitForExitError: cleanupError })
    queryMock.mockImplementationOnce(({ options }) => {
      options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      throw constructionError
    })
    const liveCleanupFailure = startClaudeCodeRun(request(), {
      ...unused.spec,
      spawn: () => liveChildCleanupFailure.handle,
    })
    await expect(liveCleanupFailure).rejects.toMatchObject({
      message: `subagent-claude-code: ${expectedFailureDiagnostic('query-start', 'unknown')}; subagent-claude-code: ${expectedFailureDiagnostic('teardown', 'unknown', { exitCode: 0, signal: null })}`,
      errors: [
        expect.objectContaining({ cause: constructionError }),
        expect.objectContaining({ cause: cleanupError }),
      ],
    })
    await expect(liveCleanupFailure)
      .rejects.not.toThrow('query construction failed with a live child')
    await expect(liveCleanupFailure)
      .rejects.not.toThrow('live child cleanup failed')
  })
})

describe('query and process disposal', () => {
  it('closes the query, terminates the tree, and waits for direct-child outcome', async () => {
    const child = fakeChild()
    const close = vi.fn()
    await disposeClaudeCodeChild({ close }, child.handle)
    expect(close).toHaveBeenCalledOnce()
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledWith()
    await expect(child.handle.done).resolves.toEqual({
      exitCode: 0,
      signal: null,
    })
  })

  it('reports a published teardown failure to the Host diagnostic sink', async () => {
    const fixture = fakeRun([success('exact answer')])
    const onError = vi.fn<NonNullable<ClaudeCodeRunSpec['onError']>>()
    const run = await startClaudeCodeRun(request(), {
      ...fixture.spec,
      onError,
    })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    fixture.close.mockImplementationOnce(() => {
      throw new Error('SECRET_TOKEN close failure')
    })
    await expect(run.dispose()).rejects.toThrow(
      expectedFailureDiagnostic('teardown', 'unknown', {
        exitCode: 0,
        signal: null,
      }),
    )
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'error')
    expect(errorCause(onError.mock.calls[0]?.[0])?.message)
      .toBe('SECRET_TOKEN close failure')
  })

  it('does not finish disposal before the managed tree exits', async () => {
    const child = fakeChild({ exitOnTerminate: false })
    let disposed = false
    const disposal = disposeClaudeCodeChild(
      { close: vi.fn() },
      child.handle,
    ).then(() => {
      disposed = true
    })
    await nextTask()
    expect(disposed).toBe(false)
    child.settle()
    await disposal
    expect(disposed).toBe(true)
  })

  it('reports close and tree-wait failures without skipping cleanup', async () => {
    const waitFailure = fakeChild({
      waitForExitError: new Error('wait boom'),
    })
    const closeFailure = vi.fn(() => { throw new Error('close boom') })
    const waitAndClose = disposeClaudeCodeChild(
      { close: closeFailure },
      waitFailure.handle,
    )
    await expect(waitAndClose).rejects.toThrow(expectedFailureDiagnostic(
      'teardown',
      'unknown',
      { exitCode: 0, signal: null },
    ))
    const waitAndCloseError = await waitAndClose.then(
      () => undefined,
      (error: unknown) => error,
    )
    const waitAndCloseCause = errorCause(waitAndCloseError)
    expect(waitAndCloseCause).toBeInstanceOf(AggregateError)
    expect((waitAndCloseCause as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'close boom' }),
      expect.objectContaining({ message: 'wait boom' }),
    ])
    expect(waitFailure.terminate).toHaveBeenCalledOnce()
  })
})
