import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  CompactionId,
  CompactionEngine,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import * as commandCompact from '@deepseek-ai/dsh-command-compact'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

const COMPACTION_ID = CompactionId('loader-command-compact-test')

const RESULT: CompactionResult = {
  compactionId: COMPACTION_ID,
  startSeq: SessionSeq(1),
  summarySeq: SessionSeq(2),
  endSeq: SessionSeq(3),
  summary: [{ type: 'text', text: 'loader summary' }],
  shadowedRange: { start: SessionSeq(3), end: SessionSeq(8) },
  shadowedSeqs: [SessionSeq(3), SessionSeq(5), SessionSeq(8)],
  shadowedTokenCount: 99,
}

class LoaderCompactionEngine extends CompactionEngine {
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
    _signal: AbortSignal,
    sourceCommandId?: Parameters<CompactionEngine['compactNow']>[2],
  ): Promise<CompactionResult | null> {
    const provenance = {
      compactionId: RESULT.compactionId,
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
    }
    agent.session.append('compaction/start', { ...provenance, turn: null })
    agent.session.append('compaction/summary', {
      ...provenance,
      summary: RESULT.summary,
      shadowedRange: RESULT.shadowedRange,
      shadowedSeqs: RESULT.shadowedSeqs,
      shadowedTokenCount: RESULT.shadowedTokenCount,
      provider: 'loader-test',
      model: 'loader-test',
    })
    agent.session.append('compaction/end', { ...provenance, turn: null })
    return Promise.resolve({ ...RESULT, ...provenance })
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('command-compact real Loader composition', () => {
  it('discovers and executes /compact through the assembled command plane', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-compact-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@test/compact-backend'",
      "- name: '@deepseek-ai/dsh-command-compact'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@test/compact-backend', LoaderCompactionEngine],
      ['@deepseek-ai/dsh-command-compact', commandCompact],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const session = Session.create(SessionId('loader-command-compact'))
    const agent = {
      session,
      status: 'idle',
      options: {},
      reserveTurnAdmission: () => () => undefined,
    } as unknown as Agent
    expect(context.commands.list(agent)).toContainEqual({
      name: 'compact',
      description: 'Compact older conversation history',
    })
    const execution = await context.commands.execute(agent, '/compact', [], new AbortController().signal)
    if (execution === undefined) throw new Error('Loader composition did not resolve /compact')
    expect(execution.result).toEqual({
      kind: 'success',
      text: 'Compacted 3 history items (~99 tokens).',
      sourceEventSeq: RESULT.summarySeq,
    })
    expect(session.snapshotEvents().map(event => ({ type: event.type, data: event.data }))).toEqual([
      {
        type: 'command/run',
        data: {
          commandId: execution.commandId,
          name: 'compact',
          args: '',
          source: { kind: 'user' },
        },
      },
      {
        type: 'compaction/start',
        data: {
          compactionId: COMPACTION_ID,
          sourceCommandId: execution.commandId,
          turn: null,
        },
      },
      {
        type: 'compaction/summary',
        data: {
          compactionId: COMPACTION_ID,
          sourceCommandId: execution.commandId,
          summary: RESULT.summary,
          shadowedRange: RESULT.shadowedRange,
          shadowedSeqs: RESULT.shadowedSeqs,
          shadowedTokenCount: RESULT.shadowedTokenCount,
          provider: 'loader-test',
          model: 'loader-test',
        },
      },
      {
        type: 'compaction/end',
        data: {
          compactionId: COMPACTION_ID,
          sourceCommandId: execution.commandId,
          turn: null,
        },
      },
      {
        type: 'command/done',
        data: {
          commandId: execution.commandId,
          kind: 'success',
          text: 'Compacted 3 history items (~99 tokens).',
          sourceEventSeq: RESULT.summarySeq,
        },
      },
    ])
    expect(session.surface.nodes).toEqual([])
    expect(session.deriveMessages()).toEqual([])
  })
})
