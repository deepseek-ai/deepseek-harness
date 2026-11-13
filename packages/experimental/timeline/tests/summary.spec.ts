import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Llm, { createSystemMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config, liveConfig } from '../src/config.ts'
import { reportSchema } from '../src/records.ts'
import type { IntervalReport, StoredRequest } from '../src/records.ts'
import { summarizeReport } from '../src/summary.ts'
import { taskLanguageInstruction } from '../src/policy.ts'

const summary = { progress: ['The planner saves changes after restart.'], uncertainties: [], userActions: [] }
const chunks: StreamChunk[] = [
  { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(summary) } },
  { type: 'finish', reason: { kind: 'stop' } },
]

class Adapter extends LlmAdapter {
  chunks = chunks
  events: string[] = []
  closed = false
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(): AsyncIterable<StreamChunk> {
    this.events.push('stream')
    try {
      for (const chunk of this.chunks) yield chunk
    } finally {
      this.closed = true
    }
  }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Llm)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const request: StoredRequest = { provider: 'fixture', model: 'summary', messages: [] }
  const input = {
    draft: reportSchema.parse({
      id: 'report-fixture',
      level: 0,
      start: 0,
      end: 60000,
      policy: '[60000]',
      children: [],
      source: 'model',
      toolCount: 1,
      covered: 1,
      contextSeq: 0,
      workMs: 60000,
      summary,
    }),
    request,
    children: [] as IntervalReport[],
    previous: undefined,
    settings: Object.assign({}, liveConfig(Config())),
    record: vi.fn<(request: StoredRequest) => Promise<void>>().mockImplementation(() => {
      adapter.events.push('record')
      return Promise.resolve()
    }),
  }
  return { ctx, adapter, input }
}

describe('independent summary queries', () => {
  it('preserves the captured prefix exactly and puts editable guidance only in the appended report request', async () => {
    const { ctx, input } = await setup()
    input.request.system = 'Main system prefix'
    input.request.messages = [
      createSystemMessage(`Main planning rules\n${taskLanguageInstruction('en')}`),
      { role: 'user', content: [{ type: 'text', text: 'Check saved work.' }] },
    ]
    input.request.tools = []
    input.settings.summaryPrompt = 'Focus on recovery evidence.'
    input.settings.levelPrompts = ['Explain any remaining recovery gap.']
    const captured = structuredClone(input.request)
    await summarizeReport(ctx.llm, input, new AbortController().signal)
    const sent = input.record.mock.calls[0]?.[0]
    expect(sent?.system).toBe(captured.system)
    expect(sent?.messages.slice(0, -1)).toEqual(captured.messages)
    const question = sent?.messages.at(-1)?.content[0]
    if (question?.type !== 'text') throw new Error('Missing report question')
    expect(question.text).toMatch(/^Write a Timeline report for /u)
    expect(question.text).toContain('Reporting focus:\nFocus on recovery evidence.')
    expect(question.text).toContain('Level guidance:\nExplain any remaining recovery gap.')
    expect(question.text).not.toContain('Previous summary')
    expect(sent?.tools).toBeUndefined()
    expect(input.request).toEqual(captured)
  })
  it('includes an older report as a comparison baseline when one exists', async () => {
    const { ctx, input } = await setup()
    const previous = { ...summary, progress: ['The planner opened with the saved plan.'] }
    await summarizeReport(ctx.llm, { ...input, previous }, new AbortController().signal)
    const question = input.record.mock.calls[0]?.[0].messages.at(-1)?.content[0]
    if (question?.type !== 'text') throw new Error('Missing report question')
    expect(
      question.text.endsWith(`Previous summary (for comparison only):\n${JSON.stringify(previous)}`),
    ).toBe(true)
  })
  it('sets the report language without changing the captured main prefix', async () => {
    const { ctx, input } = await setup()
    input.request.system = 'English main prefix'
    input.request.messages = [
      createSystemMessage('Write in English.'),
      { role: 'user', content: [{ type: 'text', text: 'Check saved work.' }] },
    ]
    input.settings.language = 'zh-CN'
    const captured = structuredClone(input.request)
    await summarizeReport(ctx.llm, input, new AbortController().signal)
    const sent = input.record.mock.calls[0]?.[0]
    expect(sent?.system).toBe(captured.system)
    expect(JSON.stringify(sent?.messages.at(-1))).toContain('简体中文')
    expect(sent?.purpose).toBe('timeline-report')
    expect(sent?.messages[1]).toEqual(captured.messages[1])
    expect(input.request).toEqual(captured)
  })
  it('uses the latest captured system message instead of rewriting an already updated language prefix', async () => {
    const { ctx, input } = await setup()
    input.settings.language = 'zh-CN'
    input.request.messages = [
      createSystemMessage(taskLanguageInstruction('en')),
      { role: 'user', content: [{ type: 'text', text: 'Continue the saved review.' }] },
      createSystemMessage(taskLanguageInstruction('zh-CN')),
    ]
    const captured = structuredClone(input.request)
    await summarizeReport(ctx.llm, input, new AbortController().signal)
    expect(input.record.mock.calls[0]?.[0].messages.slice(0, -1)).toEqual(captured.messages)
    expect(input.request).toEqual(captured)
  })
  it('keeps rollup system rules stable when global or level guidance changes', async () => {
    const { ctx, input } = await setup()
    input.children = [input.draft]
    input.draft = { ...input.draft, level: 1, children: [input.draft.id] }
    input.settings.summaryPrompt = 'First global guidance.'
    input.settings.levelPrompts = ['', 'First level guidance.']
    await summarizeReport(ctx.llm, input, new AbortController().signal)
    input.settings.summaryPrompt = 'Updated global guidance.'
    input.settings.levelPrompts = ['', 'Updated level guidance.']
    await summarizeReport(ctx.llm, input, new AbortController().signal)
    const first = input.record.mock.calls[0]?.[0]
    const second = input.record.mock.calls[1]?.[0]
    expect(first?.system).toBe(second?.system)
    expect(first?.system).not.toContain('global guidance')
    expect(JSON.stringify(second?.messages)).toContain('Updated global guidance.')
    expect(JSON.stringify(second?.messages)).toContain('Updated level guidance.')
    expect(JSON.stringify(second?.messages)).toContain(input.children[0]?.summary.progress[0])
  })
  it('gives rollups child evidence and periods without unrelated tool counters', async () => {
    const { ctx, input } = await setup()
    const child = { ...input.draft, toolCount: 123 }
    input.children = [child]
    input.draft = { ...input.draft, level: 1, children: [child.id] }
    await summarizeReport(ctx.llm, input, new AbortController().signal)
    const message = input.record.mock.calls[0]?.[0].messages.at(-1)
    const text = message?.content.find(block => block.type === 'text')?.text
    if (text === undefined) throw new Error('Missing rollup question')
    const marker = 'Combine these completed child reports:\n'
    expect(JSON.parse(text.slice(text.indexOf(marker) + marker.length))).toEqual([
      {
        start: new Date(child.start).toISOString(),
        end: new Date(child.end).toISOString(),
        summary: child.summary,
      },
    ])
    expect(child.toolCount).toBe(123)
  })
  it('records the request before dispatch without creating an Agent or storage service', async () => {
    const { ctx, adapter, input } = await setup()
    await expect(summarizeReport(ctx.llm, input, new AbortController().signal)).resolves.toEqual(summary)
    expect(adapter.events).toEqual(['record', 'stream'])
    expect(adapter.closed).toBe(true)
  })
  it('uses independent summary controls without inheriting conversation stop strings', async () => {
    const { ctx, input } = await setup()
    input.request.temperature = 0.7
    input.request.stop = ['Result']
    await expect(summarizeReport(ctx.llm, input, new AbortController().signal)).resolves.toEqual(summary)
    expect(input.record.mock.calls[0]?.[0]).toMatchObject({ maxTokens: 4096 })
    expect(input.record.mock.calls[0]?.[0].temperature).toBeUndefined()
    expect(input.record.mock.calls[0]?.[0].stop).toBeUndefined()
    expect(input.request).toMatchObject({ temperature: 0.7, stop: ['Result'] })
  })
  it('keeps Session routing for rollups and format repair without repeating the conversation', async () => {
    const { ctx, adapter, input } = await setup()
    input.request.sessionId = SessionId('summary-session')
    input.request.messages = [{ role: 'user', content: [{ type: 'text', text: 'Private main context.' }] }]
    input.children = [input.draft]
    input.draft = { ...input.draft, level: 1, children: [input.draft.id] }
    input.record.mockImplementationOnce(() => {
      adapter.chunks = [
        { type: 'block-end', index: 0, block: { type: 'text', text: 'Invalid JSON' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return Promise.resolve()
    })
    input.record.mockImplementationOnce(() => {
      adapter.chunks = chunks
      return Promise.resolve()
    })
    await expect(summarizeReport(ctx.llm, input, new AbortController().signal)).resolves.toEqual(summary)
    expect(input.record).toHaveBeenCalledTimes(2)
    for (const [request] of input.record.mock.calls) {
      expect(request.sessionId).toBe(input.request.sessionId)
      expect(JSON.stringify(request.messages)).not.toContain('Private main context.')
    }
  })
  it('does not dispatch when recording fails', async () => {
    const { ctx, adapter, input } = await setup()
    input.record.mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(summarizeReport(ctx.llm, input, new AbortController().signal)).rejects.toThrow(
      'Storage unavailable',
    )
    expect(adapter.events).toEqual([])
  })
  it.each([
    ['tool start', [{ type: 'block-start', index: 0, blockType: 'tool-call' }], 'cannot call tools'],
    [
      'completed tool block',
      [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('finished-tool'), name: 'echo', arguments: '{}' } }],
      'cannot call tools',
    ],
    [
      'tool delta',
      [{ type: 'tool-call-delta', index: 0, id: ToolCallId('fixture-tool'), argumentsDelta: '{}' }],
      'cannot call tools',
    ],
    ['missing finish', chunks.slice(0, 1), 'did not finish normally'],
    [
      'token limit',
      [...chunks.slice(0, 1), { type: 'finish', reason: { kind: 'max-tokens' } }],
      'did not finish normally',
    ],
    [
      'data after finish',
      [...chunks, { type: 'text-delta', index: 0, text: 'Unexpected content' }],
      'after its terminal finish',
    ],
    [
      'provider failure',
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'Invalid API key' } } }],
      'AUTH: Invalid API key',
    ],
  ] satisfies [string, StreamChunk[], string][])(
    'rejects %s and closes the stream without a format repair',
    async (_name, response, message) => {
      const { ctx, adapter, input } = await setup()
      adapter.chunks = response
      await expect(summarizeReport(ctx.llm, input, new AbortController().signal)).rejects.toThrow(message)
      expect(input.record).toHaveBeenCalledTimes(1)
      expect(adapter.closed).toBe(true)
    },
  )
  it('counts UTF-8 bytes and closes oversized streams', async () => {
    const { ctx, adapter, input } = await setup()
    adapter.chunks = [{ type: 'block-end', index: 0, block: { type: 'text', text: '任务'.repeat(100) } }]
    input.settings.maxResponseBytes = 300
    await expect(summarizeReport(ctx.llm, input, new AbortController().signal)).rejects.toThrow(
      'maxResponseBytes',
    )
    expect(adapter.closed).toBe(true)
  })
  it('does not dispatch after cancellation during request recording', async () => {
    const { ctx, adapter, input } = await setup()
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    input.record.mockImplementation(() => {
      started.resolve(undefined)
      return release.promise
    })
    const controller = new AbortController()
    const result = summarizeReport(ctx.llm, input, controller.signal)
    const rejected = expect(result).rejects.toThrow('Canceled while recording')
    await started.promise
    controller.abort(new Error('Canceled while recording'))
    release.resolve(undefined)
    await rejected
    expect(adapter.events).toEqual([])
  })
})
