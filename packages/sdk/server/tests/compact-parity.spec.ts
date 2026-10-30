/** Compare SDK compaction with the native command entry used by Desktop. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

const HISTORY = 'Preserve the migration requirement: keep the existing public file format and validate the result. '.repeat(80)
const SUMMARY = 'Keep the existing public file format and validate the migration.'

/** Request identities and cancellation signals are not model context. */
function modelInput(options: GenerateOptions) {
  return structuredClone({
    provider: options.provider,
    model: options.model,
    system: options.system,
    messages: options.messages.map(message => ({ role: message.role, content: message.content })),
    tools: options.tools,
    toolHistory: options.toolHistory,
    temperature: options.temperature,
    reasoningEffort: options.reasoningEffort,
    maxTokens: options.maxTokens,
    stop: options.stop,
    purpose: options.purpose,
  })
}

class ScriptedModel extends LlmAdapter {
  readonly requests: ReturnType<typeof modelInput>[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(modelInput(options))
    const text = options.purpose === 'compaction' ? SUMMARY : this.requests.length === 1 ? 'READY' : 'CONTINUED'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Both paths use the same real services and input delivery; only the command entry differs. */
async function compactAndContinue(path: 'sdk' | 'native', cwd: string) {
  const ctx = new Context()
  let server: HarnessSdkJsonRpcServer | undefined
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(BasicCompactionEngine, { auto: false })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(CommandCompact)
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'read_marker',
      description: 'Read a marker from the workspace.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.reject(new Error('The model script does not call tools')),
    })))
    const model = new ScriptedModel()
    ctx.effect(() => ctx.llm.registerAdapter(['compact-parity'], model))
    server = new HarnessSdkJsonRpcServer(ctx, {
      request: async () => { throw new Error('The model script does not request user input') },
      notify: () => {},
    })
    await server.initialize({ cwd, provider: 'compact-parity', model: 'compact-parity' })
    const sessionId = SessionId('main')
    await server.prompt({ sessionId, contentBlocks: [{ type: 'text', text: HISTORY }] })
    await server.wait({ sessionId })
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('SDK prompt did not create its Agent')

    const routed = path === 'sdk'
      ? await server.query({ sessionId, contentBlocks: [{ type: 'text', text: '/compact' }] })
      : undefined
    const execution = path === 'sdk'
      ? routed?.kind === 'command' ? routed.execution : undefined
      : await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    await server.prompt({ sessionId, contentBlocks: [{ type: 'text', text: 'Continue from the migration requirements.' }] })
    await server.wait({ sessionId })
    const events = agent.session.snapshotEvents()
    return {
      requests: model.requests,
      turns: events.filter(event => event.type === 'turn/start').map(event => event.data.turn),
      steps: events.filter(event => event.type === 'step/start').map(event => ({ turn: event.data.turn, step: event.data.step })),
      compactionOwners: events.filter(event => event.type === 'compaction/start' || event.type === 'compaction/end')
        .map(event => event.data.turn),
    }
  } finally {
    try {
      await server?.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  }
}

it('preserves native compact model inputs and turn boundaries through the SDK command entry', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-sdk-compact-parity-'))
  try {
    const native = await compactAndContinue('native', cwd)
    const sdk = await compactAndContinue('sdk', cwd)
    expect(sdk).toEqual(native)
    expect(sdk.requests.map(request => request.purpose)).toEqual([undefined, 'compaction', undefined])
    expect(sdk.requests[0]?.tools?.map(tool => tool.name)).toEqual(['read_marker'])
    expect(sdk.requests[2]?.messages.flatMap(message => message.content))
      .toEqual(expect.arrayContaining([{ type: 'text', text: SUMMARY }]))
    expect(sdk.turns).toEqual([1, 2])
    expect(sdk.steps).toEqual([{ turn: 1, step: 1 }, { turn: 2, step: 1 }])
    expect(sdk.compactionOwners).toEqual([null, null])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
