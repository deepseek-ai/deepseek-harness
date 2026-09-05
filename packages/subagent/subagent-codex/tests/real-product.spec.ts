import { execFile } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as codex from '../src/index.ts'
import type { CodexPermissionMode } from '../src/run.ts'
import {
  startResponsesFixture,
  type ResponsesBehavior,
  type ResponsesFixture,
} from './responses-fixture.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const codexBinDir = join(packageRoot, 'node_modules', '.bin')
const codexPackageJson = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(readFileSync(
  codexPackageJson,
  'utf8',
)) as { version: string; bin: { codex: string } }
const codexEntry = resolve(dirname(codexPackageJson), codexPackage.bin.codex)
const codexPackageRoot = dirname(dirname(codexEntry))

const roots: string[] = []
const fixtures: ResponsesFixture[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 30_000)

interface RealHarness {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly spawnSpecs: SubprocessSpawnSpec[]
  readonly parent: Agent
  readonly env: Record<string, string>
  readonly workspace: string
}

interface RealInstanceFixture {
  readonly fixture: ResponsesFixture
  readonly env: Record<string, string>
  readonly workspace: string
}

type ResponsesScript = readonly ResponsesBehavior[] | ((workspace: string) => readonly ResponsesBehavior[])

async function realInstanceFixture(
  script: ResponsesScript,
): Promise<RealInstanceFixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-real-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  mkdirSync(workspace)
  mkdirSync(codexHome)
  const fixture = await startResponsesFixture(typeof script === 'function' ? script(workspace) : script)
  fixtures.push(fixture)
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'disable_response_storage = true',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Responses"',
    `base_url = "${fixture.baseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'))
  const env = {
    OPENAI_API_KEY: 'dsh-fake-openai-key',
    CODEX_HOME: codexHome,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    PATH: `${codexBinDir}${delimiter}${process.env.PATH ?? ''}`,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
  return { fixture, env, workspace }
}

interface RealRuntime {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly spawnSpecs: SubprocessSpawnSpec[]
}

async function realRuntime(): Promise<RealRuntime> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const spawnSpecs: SubprocessSpawnSpec[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    spawnSpecs.push(spec)
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })
  return { ctx, handles, spawnSpecs }
}

async function realHarness(
  script: ResponsesScript,
  permissionMode?: CodexPermissionMode,
): Promise<{
  readonly harness: RealHarness
  readonly fixture: ResponsesFixture
}> {
  const instance = await realInstanceFixture(script)
  const { ctx, handles, spawnSpecs } = await realRuntime()
  await ctx.plugin(codex, {
    env: instance.env,
    ...permissionMode === undefined ? {} : { permissionMode },
    disposeGraceMs: 2_000,
  })
  const parent = {
    id: 'real-parent',
    session: { header: { cwd: instance.workspace } },
  } as unknown as Agent
  return {
    harness: {
      ctx,
      handles,
      spawnSpecs,
      parent,
      env: instance.env,
      workspace: instance.workspace,
    },
    fixture: instance.fixture,
  }
}

async function expectQuiescent(handles: readonly SubprocessHandle[]): Promise<void> {
  expect(handles.length).toBeGreaterThan(0)
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

function expectedProcessExitDiagnostic(outcome: SubprocessOutcome): string {
  const fields = [
    'product: Codex',
    'stage: process',
    'category: process',
  ]
  if (outcome.exitCode !== null) fields.push(`exit code: ${outcome.exitCode}`)
  if (outcome.signal !== null) fields.push(`signal: ${outcome.signal}`)
  return `Product subagent failure (${fields.join('; ')})`
}

interface JsonSchemaNode {
  readonly properties?: Record<string, JsonSchemaNode>
  readonly required?: string[]
  readonly type?: string | string[]
}

function responseInputTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) return []
  return body.input.flatMap((item): string[] => {
    if (item === null || typeof item !== 'object') return []
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.flatMap((part): string[] => (
      part !== null
      && typeof part === 'object'
      && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    ))
  })
}

describe('real @openai/codex 0.149.1 product', () => {
  it('starts approve-for-me through the real app-server and returns exact text', async () => {
    const sentinel = 'REAL_CODEX_SENTINEL_0_149_1'
    const task = 'Return the fixture sentinel exactly.'
    const { harness, fixture } = await realHarness([
      { kind: 'complete', text: sentinel },
    ], 'approve-for-me')
    expect(codexPackage.version).toBe('0.149.1')
    const version = await execFileAsync(process.execPath, [codexEntry, '--version'], {
      env: { ...process.env, ...harness.env },
    })
    expect(version.stdout.trim()).toBe('codex-cli 0.149.1')
    const schemaRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-schema-'))
    roots.push(schemaRoot)
    await execFileAsync(process.execPath, [
      codexEntry,
      'app-server',
      'generate-json-schema',
      '--out',
      schemaRoot,
    ], { env: { ...process.env, ...harness.env } })
    const schema = JSON.parse(readFileSync(
      join(schemaRoot, 'ClientRequest.json'),
      'utf8',
    )) as {
      definitions: {
        ThreadStartParams: JsonSchemaNode
      }
    }
    expect(schema.definitions.ThreadStartParams.properties?.model).toEqual({
      type: ['string', 'null'],
    })
    expect(schema.definitions.ThreadStartParams.required).toBeUndefined()

    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: task }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: sentinel }],
      stopReason: 'completed',
    })
    await run.dispose()

    expect(harness.spawnSpecs[0]?.argv).toEqual([
      process.execPath,
      codexEntry,
      'app-server',
      '--stdio',
    ])

    expect(fixture.requests).toHaveLength(1)
    const recorded = fixture.requests[0]!
    expect(recorded.method).toBe('POST')
    expect(recorded.path).toBe('/v1/responses')
    expect(recorded.headers.authorization).toBe('Bearer dsh-fake-openai-key')
    expect(recorded.body.model).toBe('fixture-model')
    expect(responseInputTexts(recorded.body)).toContain(task)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('fails a missing platform payload without falling back to a host codex', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-missing-payload-'))
    roots.push(root)
    const isolatedPackage = join(root, 'node_modules', '@openai', 'codex')
    mkdirSync(dirname(isolatedPackage), { recursive: true })
    cpSync(codexPackageRoot, isolatedPackage, { recursive: true, dereference: true })
    const isolatedEntry = join(isolatedPackage, 'bin', 'codex.js')

    await expect(execFileAsync(process.execPath, [isolatedEntry, '--version'], {
      env: {
        PATH: codexBinDir,
        ...process.platform === 'win32' && process.env.SystemRoot !== undefined
          ? { SystemRoot: process.env.SystemRoot }
          : {},
      },
    })).rejects.toThrow(/Missing optional dependency @openai\/codex-[a-z0-9-]+/)
  }, 30_000)

  it('runs two named instances concurrently and unloads one without revoking its run', async () => {
    const safeInstance = await realInstanceFixture([{ kind: 'hold' }])
    const bypassInstance = await realInstanceFixture([{
      kind: 'complete',
      text: 'NAMED_CODEX_BYPASS_RESULT',
    }])
    const { ctx, handles, spawnSpecs } = await realRuntime()
    const safeFiber = await ctx.plugin(codex, {
      providerName: 'codex-safe',
      model: 'codex-safe-model',
      env: safeInstance.env,
      permissionMode: 'never',
      disposeGraceMs: 2_000,
    })
    const bypassFiber = await ctx.plugin(codex, {
      providerName: 'codex-bypass',
      model: 'codex-bypass-model',
      env: bypassInstance.env,
      permissionMode: 'dangerously-bypass-approvals-and-sandbox',
      disposeGraceMs: 2_000,
    })
    const safeParent = {
      id: 'safe-parent',
      session: { header: { cwd: safeInstance.workspace } },
    } as unknown as Agent
    const bypassParent = {
      id: 'bypass-parent',
      session: { header: { cwd: bypassInstance.workspace } },
    } as unknown as Agent
    const safeController = new AbortController()

    const [safeRun, bypassRun] = await Promise.all([
      ctx.subagents.start('codex-safe', {
        prompt: [{ type: 'text', text: 'Hold the safe instance.' }],
        parent: safeParent,
        signal: safeController.signal,
      }),
      ctx.subagents.start('codex-bypass', {
        prompt: [{ type: 'text', text: 'Complete the bypass instance.' }],
        parent: bypassParent,
        signal: new AbortController().signal,
      }),
    ])
    await safeInstance.fixture.requestStarted
    await safeFiber.dispose()
    expect(ctx.subagents.list()).toEqual(['codex-bypass'])
    await expect(ctx.subagents.start('codex-safe', {
      prompt: [{ type: 'text', text: 'This start must fail.' }],
      parent: safeParent,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NO_PROVIDER' })

    await expect(bypassRun.result).resolves.toEqual({
      output: [{ type: 'text', text: 'NAMED_CODEX_BYPASS_RESULT' }],
      stopReason: 'completed',
    })
    safeController.abort(new Error('cancel only the published safe run'))
    await expect(safeRun.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    await Promise.all([safeRun.dispose(), bypassRun.dispose()])
    expect(safeInstance.fixture.requests).toHaveLength(1)
    expect(bypassInstance.fixture.requests).toHaveLength(1)
    expect(safeInstance.fixture.requests[0]?.body.model).toBe('codex-safe-model')
    expect(bypassInstance.fixture.requests[0]?.body.model).toBe('codex-bypass-model')
    expect(safeInstance.fixture.requests[0]?.body.input)
      .not.toEqual(bypassInstance.fixture.requests[0]?.body.input)
    expect(spawnSpecs.map(spec => spec.env?.CODEX_HOME).sort()).toEqual([
      safeInstance.env.CODEX_HOME,
      bypassInstance.env.CODEX_HOME,
    ].sort())
    await expectQuiescent(handles)
    await bypassFiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  }, 60_000)

  it('overrides on-request with never and reports a denied command safely', async () => {
    const command = process.platform === 'win32'
      ? 'cmd /c type nul > approval-side-effect'
      : 'touch approval-side-effect'
    const commandCalls = [
      {
        name: 'exec_command',
        arguments: {
          cmd: command,
          sandbox_permissions: 'require_escalated',
          justification: 'exercise the unattended approval boundary',
        },
      },
      {
        name: 'shell_command',
        arguments: {
          command,
          sandbox_permissions: 'require_escalated',
          justification: 'exercise the unattended approval boundary',
        },
      },
    ] as const
    const { harness, fixture } = await realHarness([
      {
        kind: 'advertisedFunctionCall',
        choices: commandCalls,
      },
      {
        kind: 'error',
        status: 400,
        message: 'fixture terminal failure after permission denial',
      },
    ])
    const sideEffect = join(harness.workspace, 'approval-side-effect')
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Attempt the fixture command.' }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    expect(result.output).toEqual([])
    expect(result.stopReason).toBe('error')
    const diagnosticLines = result.diagnostic?.split('\n') ?? []
    expect(diagnosticLines[0]).toBe(
      'Product subagent failure (product: Codex; stage: turn; category: product-error)',
    )
    expect(diagnosticLines).toHaveLength(1)
    expect(result.diagnostic).not.toContain(command)
    expect(result.diagnostic).not.toContain(harness.workspace)
    await run.dispose()

    expect(existsSync(sideEffect)).toBe(false)
    expect(fixture.requests).toHaveLength(2)
    const tools = fixture.requests[0]!.body.tools as Array<Record<string, unknown>>
    expect(commandCalls.some(call => tools.some(tool => (
      tool.type === 'function' && tool.name === call.name
    )))).toBe(true)
    expect(fixture.requests.every(requestEntry =>
      requestEntry.headers.authorization === 'Bearer dsh-fake-openai-key',
    )).toBe(true)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('reports a real service failure and an early app-server exit safely', async () => {
    {
      const { harness } = await realHarness([{
        kind: 'error',
        status: 503,
        message: 'SECRET_TOKEN in /private/secret.txt',
      }])
      const run = await harness.ctx.subagents.start('codex', {
        prompt: [{ type: 'text', text: 'Exercise the service failure path.' }],
        parent: harness.parent,
        signal: new AbortController().signal,
      })
      const result = await run.result
      expect(result).toMatchObject({ output: [], stopReason: 'error' })
      expect(result.diagnostic).toBe(
        'Product subagent failure (product: Codex; stage: turn; category: service)',
      )
      expect(result.diagnostic).not.toContain('SECRET_TOKEN')
      expect(result.diagnostic).not.toContain('/private/secret.txt')
      await run.dispose()
      await expectQuiescent(harness.handles)
    }
    {
      const { harness, fixture } = await realHarness([{ kind: 'hold' }])
      const run = await harness.ctx.subagents.start('codex', {
        prompt: [{ type: 'text', text: 'Exercise the process failure path.' }],
        parent: harness.parent,
        signal: new AbortController().signal,
      })
      await fixture.requestStarted
      expect(harness.handles).toHaveLength(1)
      harness.handles[0]!.terminate()
      const outcome = await harness.handles[0]!.done
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedProcessExitDiagnostic(outcome),
        stopReason: 'error',
      })
      await run.dispose()
      await expectQuiescent(harness.handles)
    }
  }, 60_000)

  it('executes an explicitly selected dangerous bypass write in the isolated workspace', async () => {
    const sideEffect = 'bypass-side-effect'
    const { harness, fixture } = await realHarness((workspace): readonly ResponsesBehavior[] => {
      const target = join(workspace, sideEffect)
      const command = process.platform === 'win32'
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${target.replaceAll("'", "''")}' -Value 'bypass' -NoNewline"`
        : `printf bypass > ${JSON.stringify(target)}`
      const commandCalls = [
        {
          name: 'exec_command',
          arguments: {
            cmd: command,
          },
        },
        {
          name: 'shell_command',
          arguments: {
            command,
          },
        },
      ] as const
      return [
        { kind: 'advertisedFunctionCall', choices: commandCalls },
        { kind: 'complete', text: 'bypass complete' },
      ]
    }, 'dangerously-bypass-approvals-and-sandbox')
    const target = join(harness.workspace, sideEffect)
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Create the fixture side effect.' }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'bypass complete' }],
      stopReason: 'completed',
    })
    expect(existsSync(target), JSON.stringify(fixture.requests.at(-1)?.body.input)).toBe(true)
    expect(readFileSync(target, 'utf8').trim()).toBe('bypass')
    await run.dispose()
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('settles cancellation locally and leaves the real app-server tree quiescent', async () => {
    const { harness, fixture } = await realHarness([{ kind: 'hold' }])
    const controller = new AbortController()
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Wait for cancellation.' }],
      parent: harness.parent,
      signal: controller.signal,
    })
    await fixture.requestStarted
    controller.abort(new Error('real product cancellation'))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
    await expectQuiescent(harness.handles)
  }, 60_000)
})
