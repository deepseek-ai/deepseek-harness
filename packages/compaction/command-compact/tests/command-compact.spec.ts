import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import {
  CompactionId,
  CompactionEngine,
  ManualCompactionError,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'

const COMPACTION_ID = CompactionId('command-compact-test')

const RESULT: CompactionResult = {
  compactionId: COMPACTION_ID,
  startSeq: 1,
  summarySeq: 2,
  endSeq: 3,
  summary: [{ type: 'text', text: 'summary' }],
  shadowedRange: { start: 1, end: 7 },
  shadowedSeqs: [1, 3, 7],
  shadowedTokenCount: 42,
}

class StubCompactionEngine extends CompactionEngine {
  result: CompactionResult | null = RESULT
  failure: unknown
  operation: (() => Promise<CompactionResult | null>) | undefined
  calls: { agent: ManualCompactAgentContext; signal: AbortSignal }[] = []

  override compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.resolve(RESULT)
  }

  override compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: Parameters<CompactionEngine['compactNow']>[2],
  ): Promise<CompactionResult | null> {
    this.calls.push({ agent, signal })
    if (this.operation !== undefined) return this.operation()
    return this.failure === undefined
      ? Promise.resolve(this.result === null ? null : this.appendResult(agent, this.result, sourceCommandId))
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise arbitrary backend rejection values.
      : Promise.reject(this.failure)
  }

  private appendResult(
    agent: ManualCompactAgentContext,
    result: CompactionResult,
    sourceCommandId: Parameters<CompactionEngine['compactNow']>[2],
  ): CompactionResult {
    const provenance = {
      compactionId: result.compactionId,
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
    }
    agent.session.append('compaction/start', { ...provenance, turn: null })
    agent.session.append('compaction/summary', {
      ...provenance,
      summary: result.summary,
      shadowedRange: result.shadowedRange,
      shadowedSeqs: result.shadowedSeqs,
      shadowedTokenCount: result.shadowedTokenCount,
      provider: 'command-test',
      model: 'command-test',
    })
    agent.session.append('compaction/end', { ...provenance, turn: null })
    return { ...result, ...provenance }
  }
}

interface Harness {
  readonly ctx: Context
  readonly compact: StubCompactionEngine
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  const compact = new StubCompactionEngine(ctx)
  const plugin = await ctx.plugin(commandCompact)
  const session = Session.create(SessionId('command-compact'))
  const agent = {
    session,
    status: 'idle',
    options: {},
    reserveTurnAdmission: () => () => undefined,
  } as unknown as Agent
  return { ctx, compact, agent, plugin }
}

async function run(
  test: Harness,
  suffix = '',
  controller = new AbortController(),
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>> {
  const execution = await test.ctx.commands.execute(test.agent, `/compact${suffix}`, [], controller.signal)
  if (execution === undefined) throw new Error('compact command was not registered')
  return execution
}

/** Assert the executor-owned lifecycle pair and absence from model history. */
function expectLastLifecycle(
  test: Harness,
  args: string,
  outcome: CommandResult,
): string {
  const lifecycle = test.agent.session.snapshotEvents()
    .filter(event => event.type === 'command/run' || event.type === 'command/done')
    .slice(-2)
  const runEvent = lifecycle[0]
  const doneEvent = lifecycle[1]
  if (runEvent?.type !== 'command/run' || doneEvent?.type !== 'command/done') {
    throw new Error(`expected command lifecycle pair, got ${lifecycle.map(event => event.type).join(',')}`)
  }
  expect(lifecycle.map(event => ({ type: event.type, data: event.data }))).toEqual([
    {
      type: 'command/run',
      data: {
        commandId: runEvent.data.commandId,
        name: 'compact',
        args,
        source: { kind: 'user' },
      },
    },
    {
      type: 'command/done',
      data: {
        commandId: runEvent.data.commandId,
        ...outcome,
      },
    },
  ])
  expect(doneEvent.data.commandId).toBe(runEvent.data.commandId)
  expect(test.agent.session.surface.nodes).toEqual([])
  expect(test.agent.session.deriveMessages()).toEqual([])
  return runEvent.data.commandId
}

describe('@deepseek-ai/dsh-command-compact registration', () => {
  it('registers one argument-free command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandCompact.name).toBe('command-compact')
    expect(commandCompact.inject).toEqual(['commands', 'compaction'])
    expect('default' in commandCompact).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandCompact)).toBe(commandCompact)
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'compact',
      description: 'Compact older conversation history',
    })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'compact')).toBeUndefined()
  })
})

describe('/compact human command', () => {
  it('reports success with useful accounting and forwards the exact target and signal', async () => {
    const test = await harness()
    const controller = new AbortController()
    const execution = await run(test, '', controller)
    expect(execution.result).toEqual({
      kind: 'success',
      text: 'Compacted 3 history items (~42 tokens).',
      sourceEventSeq: RESULT.summarySeq,
    })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
    expect(test.compact.calls).toEqual([{ agent: test.agent, signal: controller.signal }])
  })

  it('returns direct no-history and argument-rejection results', async () => {
    const test = await harness()
    test.compact.result = null
    const empty = await run(test)
    expect(empty.result).toEqual({
      kind: 'success',
      text: 'No compactable history yet.',
    })
    expect(empty.commandId).toBe(expectLastLifecycle(test, '', empty.result))

    const rejected = await run(test, ' now')
    expect(rejected.result).toEqual({
      kind: 'error',
      text: 'Usage: /compact (no arguments)',
    })
    expect(rejected.commandId).toBe(expectLastLifecycle(test, ' now', rejected.result))
    expect(test.compact.calls).toHaveLength(1)
  })

  it.each([
    ['busy', 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.'],
    ['cancelled', 'Compaction cancelled.'],
    ['changed', 'The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.'],
    ['summary', 'Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.'],
    ['commit', 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.'],
    ['persistence', 'Compaction finished, but the session could not be saved.'],
  ] as const)('maps expected %s failures to direct errors', async (code, text) => {
    const test = await harness()
    test.compact.failure = new ManualCompactionError(code, 'backend detail')
    const execution = await run(test)
    expect(execution.result).toEqual({ kind: 'error', text })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
  })

  it('preserves cancellation and unexpected implementation failures', async () => {
    const cancelled = await harness()
    const controller = new AbortController()
    const abort = new Error('operator cancelled')
    cancelled.compact.operation = () => {
      controller.abort(abort)
      return Promise.reject(new ManualCompactionError('summary', 'late failure'))
    }
    await expect(run(cancelled, '', controller)).rejects.toBe(abort)
    expectLastLifecycle(cancelled, '', { kind: 'error', text: abort.message })

    const unexpected = await harness()
    const bug = new Error('unexpected backend bug')
    unexpected.compact.failure = bug
    await expect(run(unexpected)).rejects.toBe(bug)
    expectLastLifecycle(unexpected, '', { kind: 'error', text: bug.message })
  })

  it('drains an aborted handler through close and flush before plugin disposal settles', async () => {
    const test = await harness()
    const controller = new AbortController()
    const abort = new Error('operator cancelled')
    const started = Promise.withResolvers<undefined>()
    const allowClose = Promise.withResolvers<undefined>()
    const closed = Promise.withResolvers<undefined>()
    const allowFlush = Promise.withResolvers<undefined>()
    const flushed = Promise.withResolvers<undefined>()
    test.compact.operation = async () => {
      started.resolve(undefined)
      await allowClose.promise
      closed.resolve(undefined)
      await allowFlush.promise
      flushed.resolve(undefined)
      throw abort
    }

    const execution = run(test, '', controller)
    await started.promise
    controller.abort(abort)
    await expect(execution).rejects.toBe(abort)

    let disposed = false
    const disposal = test.plugin.dispose()
    void disposal.then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.ctx.commands.find(test.agent, 'compact')).toBeUndefined()
    expect(disposed).toBe(false)

    allowClose.resolve(undefined)
    await closed.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disposed).toBe(false)

    allowFlush.resolve(undefined)
    await flushed.promise
    await disposal
    expect(disposed).toBe(true)
  })
})
