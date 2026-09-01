/**
 * Keyless integration tests for the SDK subagent backend. Each spawns a REAL
 * subprocess — the SDK client package's scripted fake runtime — and drives it
 * through the REAL backend over real stdio JSON-RPC, so the handshake, the
 * turn round-trip, stop-reason mapping, cancellation, env scrubbing, and
 * quiescent disposal are all exercised end to end. No model, no key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import {
  DeepSeekHarness,
  HarnessClient,
  HarnessSession,
  SdkProtocolError,
} from '@deepseek-ai/dsh-sdk-client'
import { createProcessDeepSeekHarness } from '../../../sdk/client/src/api.ts'
import type { RuntimeProcessOptions } from '../../../sdk/client/src/launch.ts'
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as sdk from '../src/index.ts'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  sdkChildOutcome,
  startSdkRun,
  internals as runInternals,
  type SdkRunSpec,
} from '../src/run.ts'

const fakeRuntime = fileURLToPath(new URL('../../../sdk/client/tests/fake-runtime.ts', import.meta.url))
const existingPatch = fileURLToPath(new URL(
  './fixtures/loader/child.patch.yml',
  import.meta.url,
))
const defaultCreateHarness = runInternals.createHarness.bind(runInternals)
let createdHarnessOptions: DeepSeekHarnessOptions[] = []

beforeEach(() => {
  createdHarnessOptions = []
  runInternals.createHarness = (options) => {
    createdHarnessOptions.push(options)
    const runtime: RuntimeProcessOptions = {
      command: process.execPath,
      args: [fakeRuntime],
      ...options.processCwd === undefined ? {} : { cwd: options.processCwd },
      environment: () => options.env ?? process.env,
      description: 'scripted SDK subagent runtime',
      initializeTimeoutMs: options.initializeTimeoutMs ?? 5_000,
      ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
      ...options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs },
      ...options.disposeEofGraceMs === undefined ? {} : { disposeEofGraceMs: options.disposeEofGraceMs },
      ...options.disposeGraceMs === undefined ? {} : { disposeGraceMs: options.disposeGraceMs },
    }
    return createProcessDeepSeekHarness(runtime, options)
  }
})

afterEach(() => {
  runInternals.createHarness = defaultCreateHarness
})

/** A parent Agent stub. The SDK backend reads exactly one thing off it: the session header's cwd (the workspace its child inherits). */
const fakeParent = { id: 'parent', session: { header: { cwd: process.cwd() } } } as unknown as Agent

function request(text = 'p', signal = new AbortController().signal, agentOptions?: AgentOptions) {
  return {
    label: text,
    prompt: [{ type: 'text' as const, text }],
    parent: fakeParent,
    signal,
    ...agentOptions === undefined ? {} : { agentOptions },
  }
}

/** Mount the SDK backend pointed at the fake runtime, scripted by `fakeEnv`. */
async function setup(fakeEnv: Record<string, string> = {}, config: Partial<sdk.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  // The Config type models the post-validation shape, so the default registry
  // name is stated here; the Loader-composition fixture omits providerName and
  // exercises the schemastery default end to end.
  await ctx.plugin(sdk, {
    providerName: 'dsh-sdk',
    profile: 'sdk',
    patches: [],
    dshHome: process.cwd(),
    provider: 'fake-provider',
    model: 'fake-model',
    env: fakeEnv,
    ...config,
  })
  return ctx
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

function expectedFailure(fields: string): string {
  return `Subagent failure (provider: DSH SDK; ${fields})`
}

/**
 * Poll until `file` exists (the fake touches it once the probed state is
 * reached), so cancel tests wait on a CONDITION rather than an arbitrary
 * timeout. Fails loud if the child never signals readiness.
 */
async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`fake runtime never became ready (${file})`)
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('sdkChildOutcome', () => {
  it('maps each known child turn-end reason once', () => {
    expect(sdkChildOutcome({ kind: 'completed' })).toEqual({ stopReason: 'completed' })
    expect(sdkChildOutcome({ kind: 'max-tokens' })).toEqual({ stopReason: 'max-tokens' })
    expect(sdkChildOutcome({ kind: 'aborted', reason: { kind: 'user' } })).toEqual({ stopReason: 'aborted' })
    expect(sdkChildOutcome({ kind: 'aborted', reason: { kind: 'disposed' } })).toEqual({
      stopReason: 'aborted',
      diagnostic: expectedFailure('stage: session-run; category: child-disposed'),
    })
    expect(sdkChildOutcome({ kind: 'blocked' })).toEqual({ stopReason: 'refusal' })
    expect(sdkChildOutcome({ kind: 'error', error: { message: 'x', code: 'UNKNOWN' } })).toEqual({
      stopReason: 'error',
      diagnostic: expectedFailure('stage: session-run; category: child-error'),
    })
    expect(sdkChildOutcome({ kind: 'interrupted' })).toEqual({ stopReason: 'error' })
  })

  it('treats an absent or unknown reason as an error', () => {
    expect(sdkChildOutcome(undefined)).toEqual({
      stopReason: 'error',
      diagnostic: expectedFailure('stage: session-run; category: missing-terminal'),
    })
    expect(sdkChildOutcome({ kind: 'something-new' } as never)).toEqual({
      stopReason: 'error',
      diagnostic: expectedFailure('stage: session-run; category: child-unknown'),
    })
  })
})

describe('dsh-subagent-dsh-sdk provider', () => {
  it('constructs the production dsh-backed harness lazily', async () => {
    const harness = defaultCreateHarness({})
    expect(harness).toBeInstanceOf((await import('@deepseek-ai/dsh-sdk-client')).DeepSeekHarness)
    await harness.close()
  })

  it('runs a child turn end to end with a parent-unique run id', async () => {
    const ctx = await setup({ FAKE_TEXT: 'hello from sdk child' })
    const run = await ctx.subagents.start('dsh-sdk', request('do X'))
    expect(run.localAgent).toBeUndefined()
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.diagnostic).toBeUndefined()
    expect(text(result.output)).toBe('hello from sdk child')
    // dispose is idempotent (one memoized teardown).
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal

    const nextRun = await ctx.subagents.start('dsh-sdk', request('again'))
    expect(nextRun.id).not.toBe(run.id)
    await nextRun.result
    await nextRun.dispose()
    await ctx.fiber.dispose()
  })

  it('resolves relative launch files at load and forwards absolute paths', async () => {
    const ctx = await setup({ FAKE_TEXT: 'explicit dsh child' }, {
      dshBin: relative(process.cwd(), fakeRuntime),
      patches: [relative(process.cwd(), existingPatch)],
    })
    const run = await ctx.subagents.start('dsh-sdk', request())
    expect(text((await run.result).output)).toBe('explicit dsh child')
    expect(createdHarnessOptions[0]).toMatchObject({
      dshBin: fakeRuntime,
      patches: [existingPatch],
    })
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('initializes the child with the configured provider/model/maxTokens and the parent cwd', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'subagent-dsh-sdk-init-'))
    const recordFile = join(tmp, 'init.jsonl')
    try {
      const ctx = await setup({ FAKE_RECORD_INIT: recordFile }, { maxTokens: 4096 })
      const run = await ctx.subagents.start('dsh-sdk', request())
      await run.result
      await run.dispose()
      const { readFileSync } = await import('node:fs')
      const records = readFileSync(recordFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(records).toEqual([{
        cwd: process.cwd(),
        provider: 'fake-provider',
        model: 'fake-model',
        maxTokens: 4096,
      }])
      await ctx.fiber.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('preserves instance defaults around a partial request override', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'subagent-dsh-sdk-partial-route-'))
    const recordFile = join(tmp, 'init.jsonl')
    try {
      const ctx = await setup({ FAKE_RECORD_INIT: recordFile }, { maxTokens: 4096 })
      const run = await ctx.subagents.start('dsh-sdk', request('partial', new AbortController().signal, {
        reasoningEffort: ReasoningEffortId('high'),
      }))
      await run.result
      await run.dispose()
      const { readFileSync } = await import('node:fs')
      expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toEqual({
        cwd: process.cwd(),
        provider: 'fake-provider',
        model: 'fake-model',
        reasoningEffort: 'high',
        maxTokens: 4096,
      })
      await ctx.fiber.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('isolates complete per-run route overrides on concurrent children', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'subagent-dsh-sdk-routes-'))
    const recordFile = join(tmp, 'init.jsonl')
    try {
      const ctx = await setup({ FAKE_RECORD_INIT: recordFile }, { maxTokens: 4096 })
      const runs = await Promise.all([
        ctx.subagents.start('dsh-sdk', request('first', new AbortController().signal, {
          provider: 'provider-a',
          model: 'model-a',
          reasoningEffort: ReasoningEffortId('high'),
          maxTokens: 111,
        })),
        ctx.subagents.start('dsh-sdk', request('second', new AbortController().signal, {
          provider: 'provider-b',
          model: 'model-b',
          reasoningEffort: ReasoningEffortId('max'),
          maxTokens: 222,
        })),
      ])
      await Promise.all(runs.map(run => run.result))
      await Promise.all(runs.map(run => run.dispose()))
      const { readFileSync } = await import('node:fs')
      const records = readFileSync(recordFile, 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .sort((left, right) => String(left.provider).localeCompare(String(right.provider)))
      expect(records).toEqual([
        {
          cwd: process.cwd(),
          provider: 'provider-a',
          model: 'model-a',
          reasoningEffort: 'high',
          maxTokens: 111,
        },
        {
          cwd: process.cwd(),
          provider: 'provider-b',
          model: 'model-b',
          reasoningEffort: 'max',
          maxTokens: 222,
        },
      ])
      await ctx.fiber.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('scrubs ambient credentials but forwards explicit config env', async () => {
    process.env.DSH_TEST_AMBIENT_SECRET_KEY = 'leak-me-not'
    try {
      const ctx = await setup({
        FAKE_ECHO_ENV: 'DSH_TEST_AMBIENT_SECRET_KEY,DEEPSEEK_API_KEY',
        DEEPSEEK_API_KEY: 'explicit-child-key',
        FAKE_TEXT: 'done',
      })
      const run = await ctx.subagents.start('dsh-sdk', request())
      const result = await run.result
      const answer = text(result.output)
      expect(answer).toContain('DSH_TEST_AMBIENT_SECRET_KEY=\n')
      expect(answer).toContain('DEEPSEEK_API_KEY=explicit-child-key')
      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      delete process.env.DSH_TEST_AMBIENT_SECRET_KEY
    }
  })

  it('maps a max-tokens child turn end', async () => {
    const ctx = await setup({ FAKE_REASON_KIND: 'max-tokens', FAKE_STATUS: 'error' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    expect(result.diagnostic).toBeUndefined()
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('flattens a child turn error into stopReason error and keeps partial text', async () => {
    const ctx = await setup({ FAKE_REASON_KIND: 'error', FAKE_STATUS: 'error', FAKE_TEXT: 'partial answer' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: session-run; category: child-error'),
    )
    expect(text(result.output)).toBe('partial answer')
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps streamed text when a malformed final message prevents completion', async () => {
    const ctx = await setup({ FAKE_MALFORMED_MESSAGE: '1', FAKE_TEXT: 'stream-only answer' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result

    expect(result.stopReason).toBe('error')
    expect(text(result.output)).toBe('stream-only answer')
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('classifies a malformed child turn reason as a protocol failure', async () => {
    const ctx = await setup({ FAKE_MALFORMED_REASON: '1', FAKE_TEXT: 'partial before bad reason' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result

    expect(result).toEqual({
      output: [{ type: 'text', text: 'partial before bad reason' }],
      diagnostic: expectedFailure('stage: session-run; category: protocol'),
      stopReason: 'error',
    })
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps streamed text when the terminal message is an empty usage-only step', async () => {
    // The child streams its answer, then emits an empty-content
    // assistant/message (the harness loop appends one to host usage on a
    // max-tokens step that assembled no text blocks). The empty message is
    // not assistant output and must not erase the streamed answer.
    const ctx = await setup({ FAKE_EMPTY_MESSAGE: '1', FAKE_REASON_KIND: 'max-tokens' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('max-tokens')
    expect(text(result.output)).toBe('hello from fake runtime')
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('reports a settled-without-turn child as an error', async () => {
    const ctx = await setup({ FAKE_REASON_KIND: 'none', FAKE_STATUS: 'error' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    expect(await run.result).toMatchObject({
      stopReason: 'error',
      diagnostic: expectedFailure('stage: session-run; category: missing-terminal'),
    })
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('maps a blocked child turn to the shared refusal stop reason', async () => {
    const ctx = await setup({ FAKE_REASON_KIND: 'blocked' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('refusal')
    expect(result.diagnostic).toBeUndefined()
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('aggregates safe initialize and shutdown facts when startup rollback fails', async () => {
    const rawCleanup = 'shutdown leaked /private/path SECRET_TOKEN'
    const spy = vi.spyOn(HarnessClient.prototype, 'close').mockImplementation(async function (this: HarnessClient) {
      spy.mockRestore()
      await this.close()
      throw new Error(rawCleanup)
    })
    try {
      const ctx = await setup({ FAKE_MALFORMED: '1' })
      const error = await ctx.subagents.start('dsh-sdk', request()).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as Error).message).toBe(
        `subagent-dsh-sdk: ${expectedFailure('stage: initialize; category: protocol')}; `
        + `subagent-dsh-sdk: ${expectedFailure('stage: shutdown; category: unknown')}`,
      )
      expect((error as Error).message).not.toContain(rawCleanup)
      await ctx.fiber.dispose()
    } finally {
      spy.mockRestore()
    }
  })

  it('reports only safe shutdown facts when cancelled startup rollback fails', async () => {
    const rawCleanup = 'cancelled shutdown leaked SECRET_TOKEN'
    const spy = vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async function (this: DeepSeekHarness) {
      spy.mockRestore()
      await this.close()
      throw new Error(rawCleanup)
    })
    try {
      const controller = new AbortController()
      const pending = startSdkRun(request('p', controller.signal), {
        profile: 'sdk',
        patches: [],
        dshHome: process.cwd(),
        cwd: process.cwd(),
        provider: 'p',
        model: 'm',
        env: { FAKE_HANG_INIT: '1' },
        shutdownTimeoutMs: 100,
        disposeEofGraceMs: 100,
        disposeGraceMs: 100,
      })
      controller.abort()
      const error = await pending.catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toHaveLength(1)
      expect((error as Error).message).toBe(
        `subagent-dsh-sdk: ${expectedFailure('stage: shutdown; category: unknown')}`,
      )
      expect((error as Error).message).not.toContain(rawCleanup)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps an initialize failure authoritative when a later abort flag is already set', async () => {
    const rawFailure = new SdkProtocolError('scripted initialize rejection')
    const start = vi.spyOn(DeepSeekHarness.prototype, 'start').mockRejectedValue(rawFailure)
    const close = vi.spyOn(DeepSeekHarness.prototype, 'close').mockResolvedValue()
    try {
      const controller = new AbortController()
      const pending = startSdkRun(request('p', controller.signal), {
        profile: 'sdk',
        patches: [],
        dshHome: process.cwd(),
        cwd: process.cwd(),
        provider: 'p',
        model: 'm',
        env: {},
        shutdownTimeoutMs: 100,
        disposeEofGraceMs: 100,
        disposeGraceMs: 100,
      })
      controller.abort()
      await expect(pending).rejects.toThrow(
        `subagent-dsh-sdk: ${expectedFailure('stage: initialize; category: protocol')}`,
      )
      expect(close).not.toHaveBeenCalled()
    } finally {
      start.mockRestore()
      close.mockRestore()
    }
  })

  it('preserves a disposed child cancellation without treating it as local cancellation', async () => {
    const ctx = await setup({ FAKE_REASON_KIND: 'aborted', FAKE_ABORT_REASON_KIND: 'disposed' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: session-run; category: child-disposed'),
    )
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps an ordinary child abort diagnostic-free', async () => {
    const ctx = await setup({ FAKE_REASON_KIND: 'aborted', FAKE_ABORT_REASON_KIND: 'user' })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.diagnostic).toBeUndefined()
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('uses a fixed fallback for an unknown child terminal reason', async () => {
    const rawReason = 'private/path/SECRET_TOKEN'
    const ctx = await setup({ FAKE_REASON_KIND: rawReason })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: session-run; category: child-unknown'),
    )
    expect(result.diagnostic).not.toContain(rawReason)
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('aborting the required signal settles a hung child as aborted', async () => {
    const ctx = await setup({ FAKE_HANG_PROMPT: '1' }, { disposeEofGraceMs: 200, disposeGraceMs: 200 })
    const controller = new AbortController()
    const run = await ctx.subagents.start('dsh-sdk', request('p', controller.signal))
    controller.abort('test')
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.diagnostic).toBeUndefined()
    // The hung child streamed nothing, so the aborted result has no output.
    expect(result.output).toEqual([])
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('cancelling between handshake and publish rejects start after reap', async () => {
    // The abort lands while the child is INSIDE initialize (ready-file
    // handshake window): the fake touches READY, we abort, then GO lets the
    // handshake complete — so the post-race `flags.cancelled` recheck must
    // reject even though the handshake itself succeeded.
    const tmp = mkdtempSync(join(tmpdir(), 'subagent-dsh-sdk-midcancel-'))
    const ready = join(tmp, 'ready')
    const go = join(tmp, 'go')
    try {
      const controller = new AbortController()
      const spec: SdkRunSpec = {
        profile: 'sdk',
        patches: [],
        dshHome: process.cwd(),
        cwd: process.cwd(),
        provider: 'p',
        model: 'm',
        env: { FAKE_INIT_READY: ready, FAKE_INIT_GO: go },
        shutdownTimeoutMs: 100,
        disposeEofGraceMs: 200,
        disposeGraceMs: 200,
      }
      const pending = startSdkRun(request('p', controller.signal), spec)
      await waitForFile(ready)
      controller.abort('mid-handshake')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(go, 'go\n')
      await expect(pending).rejects.toThrow('aborted before the SDK child started')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('does not attribute streamed text when prompt acceptance is malformed', async () => {
    // The fake streams one text-delta chunk but never returns the MessageId
    // needed to establish this run's durable inbox receipt. The text therefore
    // lies outside an owned activity interval and cannot become its output.
    const ctx = await setup({ FAKE_STREAM_THEN_MALFORMED: '1' }, { shutdownTimeoutMs: 100, disposeEofGraceMs: 200, disposeGraceMs: 200 })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: session-run; category: protocol'),
    )
    expect(result.output).toEqual([])
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('preserves partial output while hiding a transport error stderr tail', async () => {
    const stderr = 'private/path SECRET_TOKEN must remain Host-only'
    const ctx = await setup({
      FAKE_EXIT_DURING_PROMPT: '1',
      FAKE_TEXT: 'partial before transport exit',
      FAKE_STDERR: stderr,
    })
    const run = await ctx.subagents.start('dsh-sdk', request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([{ type: 'text', text: 'partial before transport exit' }])
    expect(result.diagnostic).toBe(
      expectedFailure('stage: session-run; category: transport'),
    )
    expect(result.diagnostic).not.toContain(stderr)
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('uses a fixed unknown category for an untyped SDK exception', async () => {
    const rawMessage = 'unknown SDK failure at /private/path SECRET_TOKEN'
    const spy = vi.spyOn(HarnessSession.prototype, 'run')
      .mockRejectedValue(new Error(rawMessage))
    try {
      const ctx = await setup()
      const run = await ctx.subagents.start('dsh-sdk', request())
      const result = await run.result
      expect(result.diagnostic).toBe(
        expectedFailure('stage: session-run; category: unknown'),
      )
      expect(result.diagnostic).not.toContain(rawMessage)
      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps child diagnostics isolated across concurrent runs', async () => {
    const start = (reason: 'error' | 'unknown-reason') => startSdkRun(request(), {
      profile: 'sdk',
      patches: [],
      dshHome: process.cwd(),
      cwd: process.cwd(),
      provider: 'p',
      model: 'm',
      env: { FAKE_REASON_KIND: reason },
      // Product-default dispose budgets: two real children are reaped under
      // runner contention, where tight windows misreport slow SIGKILL reaps.
      shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
      disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    })
    const [errored, unknown] = await Promise.all([start('error'), start('unknown-reason')])
    const [errorResult, unknownResult] = await Promise.all([errored.result, unknown.result])
    expect(errorResult.diagnostic).toContain('category: child-error')
    expect(errorResult.diagnostic).not.toContain('child-unknown')
    expect(unknownResult.diagnostic).toContain('category: child-unknown')
    expect(unknownResult.diagnostic).not.toContain('child-error')
    await Promise.all([errored.dispose(), unknown.dispose()])
  })

  it('dispose cancels a hung child locally and reaps it', async () => {
    const ctx = await setup({ FAKE_HANG_PROMPT: '1' }, { shutdownTimeoutMs: 100, disposeEofGraceMs: 200, disposeGraceMs: 200 })
    const run = await ctx.subagents.start('dsh-sdk', request())
    await run.dispose()
    expect((await run.result).stopReason).toBe('aborted')
    await ctx.fiber.dispose()
  })

  it('rejects WITHOUT spawning when the signal is already aborted', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'subagent-dsh-sdk-preabort-'))
    const sentinel = join(tmp, 'spawned')
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(startSdkRun(
        request('p', controller.signal),
        {
          profile: 'sdk',
          patches: [],
          dshHome: sentinel,
          cwd: tmp,
          provider: 'p',
          model: 'm',
          env: {},
          shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
          disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
          disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
        },
      )).rejects.toThrow('aborted before the SDK child started')
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rejects a pre-aborted request through the registered provider before cwd resolution', async () => {
    const ctx = await setup()
    const controller = new AbortController()
    controller.abort()
    const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
    await expect(ctx.subagents.start('dsh-sdk', {
      label: 'p',
      prompt: [{ type: 'text' as const, text: 'p' }],
      parent,
      signal: controller.signal,
    })).rejects.toThrow('subagent request was aborted before the SDK child started')
    await ctx.fiber.dispose()
  })

  it('rejects after reaping when the child dies before the handshake', async () => {
    const rawStderr = 'scripted boot failure at /private/path SECRET_TOKEN'
    const ctx = await setup({ FAKE_EXIT_BEFORE_INIT: '1', FAKE_STDERR: rawStderr })
    const failure = await ctx.subagents.start('dsh-sdk', request()).then(
      () => { throw new Error('start unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(String(failure)).toBe(
      `SdkRunFailure: subagent-dsh-sdk: ${expectedFailure('stage: initialize; category: transport')}`,
    )
    expect(String(failure)).not.toContain(rawStderr)
    await ctx.fiber.dispose()
  })

  it.each([
    [{ FAKE_MALFORMED: '1' }, 'protocol'],
    [{ FAKE_INIT_ERROR: '1' }, 'protocol'],
  ] as const)('rejects an initialize failure with safe %s facts', async (env, category) => {
    const ctx = await setup({ ...env })
    await expect(ctx.subagents.start('dsh-sdk', request())).rejects.toThrow(
      `subagent-dsh-sdk: ${expectedFailure(`stage: initialize; category: ${category}`)}`,
    )
    await ctx.fiber.dispose()
  })

  it('cancelling mid-handshake rejects start after reaping the child', async () => {
    const controller = new AbortController()
    const spec: SdkRunSpec = {
      profile: 'sdk',
      patches: [],
      dshHome: process.cwd(),
      cwd: process.cwd(),
      provider: 'p',
      model: 'm',
      env: { FAKE_HANG_INIT: '1' },
      shutdownTimeoutMs: 100,
      disposeEofGraceMs: 200,
      disposeGraceMs: 200,
    }
    const pending = startSdkRun(request('p', controller.signal), spec)
    controller.abort('now')
    await expect(pending).rejects.toThrow('aborted before the SDK child started')
  })

  it('routes a post-publication child failure through onError and settles error', async () => {
    const seen: string[] = []
    const spec: SdkRunSpec = {
      profile: 'sdk',
      patches: [],
      dshHome: process.cwd(),
      cwd: process.cwd(),
      provider: 'p',
      model: 'm',
      // The fake dies as soon as the prompt arrives: FAKE_HANG_PROMPT plus a
      // short-lived process is simulated by killing via dispose below instead;
      // here use FAKE_MALFORMED to make the prompt reply violate the protocol.
      env: { FAKE_MALFORMED_PROMPT: '1' },
      shutdownTimeoutMs: 100,
      disposeEofGraceMs: 200,
      disposeGraceMs: 200,
      onError: (error) => {
        seen.push(error.message)
        throw new Error('sink failure must be contained')
      },
    }
    const run = await startSdkRun(request(), spec)
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toBe(
      expectedFailure('stage: session-run; category: protocol'),
    )
    expect(seen).toHaveLength(1)
    await run.dispose()
  })

  it('routes provider-level onError through ctx.logger.warn', async () => {
    const ctx = await setup({ FAKE_MALFORMED_PROMPT: '1' })
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const run = await ctx.subagents.start('dsh-sdk', request())
    expect(await run.result).toMatchObject({
      stopReason: 'error',
      diagnostic: expectedFailure('stage: session-run; category: protocol'),
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('subagent-dsh-sdk "dsh-sdk": child run failed (error)')
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('wraps a shutdown rejection with safe facts after the runtime is reaped', async () => {
    const rawCleanup = 'shutdown failed at /private/path SECRET_TOKEN'
    const ctx = await setup()
    const run = await ctx.subagents.start('dsh-sdk', request())
    await run.result
    const spy = vi.spyOn(DeepSeekHarness.prototype, 'close').mockImplementation(async function (this: DeepSeekHarness) {
      spy.mockRestore()
      await this.close()
      throw new Error(rawCleanup)
    })
    try {
      const error = await run.dispose().catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        `subagent-dsh-sdk: ${expectedFailure('stage: shutdown; category: unknown')}`,
      )
      expect((error as Error).message).not.toContain(rawCleanup)
    } finally {
      spy.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('registers under the configured provider name and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(sdk, {
      providerName: 'sdk-hmr',
      profile: 'sdk',
      patches: [],
      dshHome: process.cwd(),
      provider: 'p',
      model: 'm',
      env: {},
    })
    expect(ctx.subagents.getProvider('sdk-hmr')?.name).toBe('sdk-hmr')
    expect(ctx.subagents.getProvider('sdk-hmr')?.inheritsParentContext).toBe(false)
    expect(ctx.subagents.getProvider('sdk-hmr')?.capabilities).toEqual({
      agentOptions: true,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    })
    await fiber.dispose()
    expect(ctx.subagents.getProvider('sdk-hmr')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects non-positive timing bounds at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    const base = { providerName: 'sdk', profile: 'sdk', patches: [], dshHome: process.cwd(), provider: 'p', model: 'm', env: {} }
    await expect(ctx.plugin(sdk, { ...base, shutdownTimeoutMs: 0 })).rejects.toThrow('shutdownTimeoutMs must be a positive finite number')
    await expect(ctx.plugin(sdk, { ...base, disposeEofGraceMs: -1 })).rejects.toThrow('disposeEofGraceMs must be a positive finite number')
    await expect(ctx.plugin(sdk, { ...base, disposeGraceMs: Number.NaN })).rejects.toThrow('disposeGraceMs must be a positive finite number')
    await ctx.fiber.dispose()
  })

  it('requires an explicit absolute Harness home for nested dsh runtimes', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(sdk, {
      providerName: 'sdk',
      profile: 'sdk',
      patches: [],
      dshHome: './personal-home',
      provider: 'p',
      model: 'm',
      env: {},
    })).rejects.toThrow('dshHome must be an absolute path')
    await ctx.fiber.dispose()
  })

  it.each([
    { field: 'dshBin', override: { dshBin: './missing-dsh-bin' } },
    { field: 'dshBin', override: { dshBin: '.' } },
    { field: 'patches[0]', override: { patches: ['./missing-child-patch.yml'] } },
  ])('rejects an invalid $field at load', async ({ field, override }) => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(sdk, {
      providerName: 'sdk',
      profile: 'sdk',
      patches: [],
      dshHome: process.cwd(),
      provider: 'p',
      model: 'm',
      env: {},
      ...override,
    })).rejects.toThrow(`${field} must name an existing file`)
    await ctx.fiber.dispose()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxTokens %s at load',
    async (maxTokens) => {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      await expect(ctx.plugin(sdk, {
        providerName: 'sdk',
        profile: 'sdk',
        patches: [],
        dshHome: process.cwd(),
        provider: 'p',
        model: 'm',
        maxTokens,
        env: {},
      })).rejects.toThrow('maxTokens')
      await ctx.fiber.dispose()
    },
  )

  it.each([0, 1.5])(
    'defensively rejects invalid maxTokens %s when apply is called directly',
    async (maxTokens) => {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      expect(() => { sdk.apply(ctx, {
        providerName: 'sdk',
        profile: 'sdk',
        patches: [],
        dshHome: process.cwd(),
        provider: 'p',
        model: 'm',
        maxTokens,
        env: {},
        shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
        disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
        disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
      }) }).toThrow('maxTokens must be a positive safe integer')
      await ctx.fiber.dispose()
    },
  )

  it('rejects an empty config cwd at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(sdk, {
      providerName: 'sdk',
      profile: 'sdk',
      patches: [],
      dshHome: process.cwd(),
      cwd: '',
      provider: 'p',
      model: 'm',
      env: {},
    })).rejects.toThrow('config cwd must not be empty')
    await ctx.fiber.dispose()
  })

  it('uses a validated config cwd override instead of the parent session cwd', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'subagent-dsh-sdk-cwd-'))
    try {
      const ctx = await setup({ FAKE_ECHO_CWD: '1', FAKE_TEXT: 'done' }, { cwd: tmp })
      const run = await ctx.subagents.start('dsh-sdk', request())
      const result = await run.result
      const { realpathSync } = await import('node:fs')
      expect(text(result.output)).toContain(`cwd=${realpathSync(tmp)}`)
      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('fails loud when neither config cwd nor parent session cwd exists', async () => {
    const ctx = await setup()
    const parent = { id: 'parent', session: { header: {} } } as unknown as Agent
    await expect(ctx.subagents.start('dsh-sdk', {
      label: 'p', prompt: [{ type: 'text' as const, text: 'p' }], parent, signal: new AbortController().signal,
    }))
      .rejects.toThrow(
        `subagent-dsh-sdk: ${expectedFailure('stage: initialize; category: configuration')}`,
      )
    await ctx.fiber.dispose()
  })

  it('keeps named plugin exports with no default export (loader shape)', () => {
    expect(sdk.name).toBe('subagent-dsh-sdk')
    expect(sdk.inject).toEqual(['subagents'])
    expect(typeof sdk.apply).toBe('function')
    expect(typeof sdk.Config).toBe('function')
    expect((sdk as Record<string, unknown>).default).toBeUndefined()
  })
})
