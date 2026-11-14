import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { createUserMessage, isAgentLoopRequest, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { textOutput } from './fixture.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/config.ts'
import * as Timeline from '../src/index.ts'
import type { PluginConfig } from '../src/config.ts'
import { Adapter, setup, summary, settle, untilReleased } from './fixture.ts'
import { reportSchema, requestRecordSchema, treeSchema } from '../src/records.ts'
import { languageText, outputLanguages } from '../src/policy.ts'

const fixtures: Awaited<ReturnType<typeof setup>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  vi.useRealTimers()
})
async function running(config = {}, adapter = new Adapter()) {
  const fixture = await setup(config, adapter)
  fixtures.push(fixture)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  fixture.start()
  await adapter.ready.promise
  return fixture
}
describe('background summaries through a real agent loop', () => {
  it('admits a waiting third Session before serving the earlier sessions again', async () => {
    const adapter = new Adapter()
    adapter.checkRelease = Promise.withResolvers<undefined>()
    const f = await setup({ maxConcurrent: 1, rollupFactors: [] }, adapter)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const agents = [f.agent]
    const ids = [f.agent.session.id]
    const handles: { close(): Promise<void> }[] = []
    try {
      f.start()
      await adapter.ready.promise
      for (const id of ['second', 'third']) {
        const agent = await f.harness.create(SessionId(id), { provider: 'fixture', model: 'timeline' })
        handles.push(await f.ctx.sessionPersistence.open(agent.session.id, 'read'))
        agent.followup(createUserMessage({
          source: { kind: 'user' }, content: [{ type: 'text', text: 'Run work.' }],
        }))
        ids.push(agent.session.id)
        agents.push(agent)
        await settle()
        await adapter.waitForMain(ids.length * 2)
      }
      await vi.advanceTimersByTimeAsync(60000)
      await adapter.checkStarted.promise
      const order = () => adapter.checks.map(check => ids.indexOf(check.sessionId!) + 1)
      for (let cycle = 0; cycle < 2; cycle++) {
        const current = agents[order().at(-1)! - 1]!
        current.session.append('tool/call', { turn: 0, step: 0, callId: ToolCallId(`additional-${cycle}`), name: 'echo', arguments: '{}' })
        f.ctx.llm.stream(adapter.main.findLast(options => options.sessionId === current.session.id)!)
        const nextCheck = Promise.withResolvers<undefined>()
        adapter.checkStarted = nextCheck
        await vi.advanceTimersByTimeAsync(61000)
        const previous = adapter.checkRelease
        adapter.checkRelease = Promise.withResolvers<undefined>()
        previous.resolve(undefined)
        await settle()
        await nextCheck.promise
      }
      expect(order()).toEqual([1, 2, 3])
    } finally {
      await f.close()
      for (const handle of handles) await handle.close()
      vi.useRealTimers()
    }
  }, 15000)
  it.each(['rejects', 'times out'] as const)('dispatches a rollup of durable children when the concurrent base request %s', async (failure) => {
    class SelectiveAdapter extends Adapter {
      rejectBase = false

      override async *stream(options: Parameters<Adapter['stream']>[0]) {
        if (this.rejectBase && options.purpose === 'timeline-report' && options.messages.length > 1) {
          this.checks.push(options)
          if (failure === 'times out') await untilReleased(new Promise<never>(() => {}), options.signal)
          throw new Error('Fixture full-history input is too large')
        }
        yield* super.stream(options)
      }
    }
    const adapter = new SelectiveAdapter()
    const f = await setup({ rollupFactors: [3], timeoutMs: 50 }, adapter)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    try {
      f.start()
      await adapter.ready.promise
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report', 1)
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report', 2)
      expect(f.reports()[0]?.source).toBe('model')
      const request = adapter.main.at(-1)!
      f.agent.session.append('tool/call', { turn: 0, step: 0, callId: ToolCallId('additional-base'), name: 'echo', arguments: '{}' })
      adapter.rejectBase = true
      f.ctx.llm.stream(request)
      await vi.advanceTimersByTimeAsync(60000)
      if (failure === 'times out') await vi.advanceTimersByTimeAsync(50)
      await f.waitRecords('plugin:timeline/failure')
      expect(f.ctx.timeline.stateOf(f.agent.session).view.error).toContain(failure === 'times out' ? 'Timeline summary timed out' : 'Fixture full-history input is too large')
      expect(f.reports().map(report => report.level)).toEqual([0, 0, 1])
      expect(adapter.checks.at(-1)?.messages).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(60000)
      if (failure === 'times out') await vi.advanceTimersByTimeAsync(50)
      await f.waitRecords('plugin:timeline/failure', 2)
      expect(f.reports().map(report => report.level)).toEqual([0, 0, 1])
      adapter.rejectBase = false
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report', 4)
      expect(f.reports().at(-1)?.level).toBe(0)
    } finally {
      await f.close()
      vi.useRealTimers()
    }
  })
  it('sends no Timeline view changes during a quiet turn with a large unchanged plan', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await setup({ reportsEnabled: false }, adapter)
    fixtures.push(f)
    const session = f.agent.session
    const now = Date.now()
    const tree = treeSchema.parse({
      id: 'plan',
      title: 'Review many changes',
      description: '',
      createdAt: now,
      tasks: Array.from({ length: 200 }, (_, index) => ({
        id: `review-${index}`, title: `Review ${index}`, parent: null, status: 'pending',
        done: [0, 1], timeShare: 1, remaining: null, mode: 'serial', note: '', description: '',
        details: 'x'.repeat(3000), createdAt: now, updatedAt: now,
      })),
    })
    const changes: unknown[] = []
    const off = f.ctx.sessionProjections.onEventChanged((current, updates) => {
      if (current === session) changes.push(...updates.filter(update => update.key === 'timeline'))
    })
    try {
      await f.ctx.timeline.append(session, 'plugin:timeline/tree', {
        version: 1, sessionId: session.id, callId: 'large-plan', tree,
      })
      changes.length = 0
      f.start()
      await adapter.ready.promise
      adapter.release.resolve(undefined)
      await f.agent.whenIdle()
      expect(changes).toEqual([])
      expect(f.ctx.timeline.stateOf(session).activity.open).toBeNull()
    } finally {
      off()
    }
  })
  it('uses the newly selected provider for a due rollup when work resumes', async () => {
    const f = await setup({ rollupFactors: [2] })
    const replacement = new Adapter()
    replacement.calls = 0
    f.ctx.llm.registerAdapter(['replacement'], replacement)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const admitted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      f.start()
      await f.adapter.ready.promise
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report', 1)
      f.adapter.release.resolve(undefined)
      await f.agent.whenIdle()
      await vi.advanceTimersByTimeAsync(120000)
      f.agent.model.select({ provider: 'replacement', model: 'timeline-new' })
      const off = f.agent.ctx.on('agent/request', async (_input, next) => {
        admitted.resolve(undefined)
        await release.promise
        return next()
      }, { prepend: true })
      try {
        f.start()
        await admitted.promise
        await f.waitRecords('plugin:timeline/report', 3)
        const provider = [...f.adapter.checks, ...replacement.checks].find(check =>
          JSON.stringify(check.messages).includes('Combine these completed child reports'))?.provider
        expect(provider).toBe('replacement')
      } finally {
        off()
      }
    } finally {
      release.resolve(undefined)
      await f.close()
      vi.useRealTimers()
    }
  })

  it('defers dispatch when Session persistence cannot acknowledge the interval', async () => {
    const f = await running()
    const flush = vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    try {
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/failure')
      expect(f.ctx.timeline.stateOf(f.agent.session).view.error).toContain('durable session persistence')
      expect(f.adapter.checks).toHaveLength(0)
      expect(f.reports()).toHaveLength(0)
    } finally {
      flush.mockRestore()
    }
  })
  it('keeps the turn alive if neither a report request nor its failure can be saved', async () => {
    const f = await running()
    const failed = Promise.withResolvers<undefined>()
    const append = vi.spyOn(f.ctx.timeline, 'append')
      .mockRejectedValueOnce('Report storage unavailable')
      .mockImplementationOnce(() => {
        failed.resolve(undefined)
        return Promise.reject(new Error('Failure storage unavailable'))
      })
    try {
      await vi.advanceTimersByTimeAsync(60000)
      await failed.promise
      await settle()
      expect(append).toHaveBeenCalledTimes(2)
      expect(append.mock.calls[1]?.[2]).toMatchObject({ message: 'Report storage unavailable' })
      expect(f.adapter.checks).toHaveLength(0)
      expect(f.reports()).toHaveLength(0)
      expect(f.agent.status).toBe('running')
    } finally {
      append.mockRestore()
    }
  })
  it('keeps task tracking available when reports are disabled at startup', async () => {
    const adapter = new Adapter()
    adapter.mainActions[0] = () => [
      {
        name: 'timeline_tree',
        arguments: JSON.stringify({ action: 'start', title: 'Fix session recovery' }),
      },
    ]
    const f = await running({ reportsEnabled: false }, adapter)
    await vi.advanceTimersByTimeAsync(15 * 60000)
    expect(f.ctx.timeline.stateOf(f.agent.session).view.trees).toMatchObject([
      { title: 'Fix session recovery' },
    ])
    expect(f.reports()).toEqual([])
    expect(adapter.checks).toEqual([])
  })
  it('keeps saved reports and resumes base reports and rollups after enabling', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await running({ rollupFactors: [2] }, adapter)
    const { reportsEnabled } = f.plugin.effectiveConfig as PluginConfig
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    const saved = f.reports()[0]
    updateVolatile(reportsEnabled, Config({ reportsEnabled: false }).reportsEnabled)
    f.plugin.ctx.emit('loader/volatile-update', [['reportsEnabled']])
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.reports()).toEqual([saved])
    updateVolatile(reportsEnabled, Config({ reportsEnabled: true }).reportsEnabled)
    f.plugin.ctx.emit('loader/volatile-update', [['reportsEnabled']])
    await f.waitRecords('plugin:timeline/report', 3)
    expect(f.reports()[0]).toEqual(saved)
    expect(f.reports().map(report => report.level)).toEqual([0, 0, 1])
    expect(adapter.checks).toEqual([])
  })
  it('cancels an in-flight report without recording a failure or stopping the turn', async () => {
    const adapter = new Adapter()
    adapter.checkRelease = Promise.withResolvers<undefined>()
    const f = await running({}, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await adapter.checkStarted.promise
    const { reportsEnabled } = f.plugin.effectiveConfig as PluginConfig
    updateVolatile(reportsEnabled, Config({ reportsEnabled: false }).reportsEnabled)
    f.plugin.ctx.emit('loader/volatile-update', [['reportsEnabled']])
    await vi.advanceTimersByTimeAsync(120000)
    await settle()
    expect(adapter.checks).toHaveLength(1)
    expect(adapter.checks[0]?.signal?.aborted).toBe(true)
    expect(adapter.active).toBe(0)
    expect(f.reports()).toEqual([])
    expect(f.ctx.timeline.stateOf(f.agent.session).view.error).toBeNull()
    expect(f.agent.status).toBe('running')
  })
  it('starts the first zero-tool interval at the turn that resumes a long-idle session', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await setup({ intervalMs: 900000, rollupFactors: [4, 4] }, adapter)
    fixtures.push(f)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    await vi.advanceTimersByTimeAsync(143 * 3600000)
    const start = Date.now()
    f.start()
    await adapter.ready.promise
    await vi.advanceTimersByTimeAsync(899999)
    expect(f.reports()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await f.waitRecords('plugin:timeline/report')
    expect(f.reports()).toMatchObject([
      { start, end: start + 900000, source: 'no-activity', ranges: [[start, start + 900000]], workMs: 900000 },
    ])
    expect(adapter.checks).toEqual([])
  })
  it.each(outputLanguages)('uses fixed %s no-activity text without a model query', async (language) => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await running({ language }, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(f.reports()[0]?.summary.progress).toEqual([languageText[language].noActivity])
    expect(adapter.checks).toHaveLength(0)
  })
  it.each([true, false])(
    'identifies independent-runtime main requests through Agent admission; main=%s',
    async (main) => {
      const f = await running()
      const namespace: unknown = await import(
        /* @vite-ignore */ `${import.meta.resolve('@deepseek-ai/dsh-llm/src/call-config.ts')}?timeline-independent-runtime`,
      )
      const independent = namespace as typeof import('@deepseek-ai/dsh-llm/src/call-config.ts')
      const previous = f.adapter.main.at(-1)
      if (previous?.signal === undefined) throw new Error('The main request signal is missing')
      const request = independent.markAgentLoopRequest({
        ...previous,
        signal: main ? previous.signal : new AbortController().signal,
        messages: [
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'Independent runtime checkpoint.' }],
          }),
        ],
      })
      expect(isAgentLoopRequest(request)).toBe(false)
      for await (const chunk of f.ctx.llm.stream(request)) void chunk
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report')
      const input = JSON.stringify(f.adapter.checks.at(-1)?.messages)
      if (main) expect(input).toContain('Independent runtime checkpoint.')
      else {
        expect(input).not.toContain('Independent runtime checkpoint.')
        expect(input).toContain('Fix session recovery.')
      }
    },
  )
  it.each(['compaction', 'session-title'] as const)(
    'excludes %s requests even when they share the admitted turn signal',
    async (purpose) => {
      const f = await running()
      const previous = f.adapter.main.at(-1)
      if (previous?.signal === undefined) throw new Error('The main request signal is missing')
      for await (const chunk of f.ctx.llm.stream({
        ...previous,
        purpose,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Auxiliary context, not the user task.' }] },
        ],
      }))
        void chunk
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report')
      const input = JSON.stringify(f.adapter.checks.at(-1)?.messages)
      expect(input).not.toContain('Auxiliary context, not the user task.')
      expect(input).toContain('Fix session recovery.')
    },
  )
  it('ignores an already cancelled main request and keeps the previous report context', async () => {
    const f = await running()
    const cancelled = new AbortController()
    await agentEvents(f.agent.ctx, f.agent).waterfall('agent/request',
      { turn: 0, step: 2, signal: cancelled.signal },
      () => Promise.resolve({ provider: 'fixture', model: 'timeline' }))
    cancelled.abort()
    for await (const chunk of f.ctx.llm.stream({
      provider: 'fixture', model: 'timeline', sessionId: f.agent.session.id, signal: cancelled.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Cancelled context' }] }],
    })) void chunk
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(JSON.stringify(f.adapter.checks.at(-1)?.messages)).toContain('Fix session recovery.')
    expect(JSON.stringify(f.adapter.checks.at(-1)?.messages)).not.toContain('Cancelled context')
  })
  it('records the request before dispatch and does not send it when persistence fails', async () => {
    const f = await running()
    const append = vi.spyOn(f.ctx.timeline, 'append').mockImplementationOnce(async () => {
      throw new Error('Cannot save request')
    })
    try {
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/failure')
      expect(f.adapter.checks).toHaveLength(0)
      expect(f.agent.status).toBe('running')
    } finally {
      append.mockRestore()
    }
  })
  it('applies elapsed thresholds to complete non-multiple periods without reusing children', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await running({ intervalMs: 600000, rollupFactors: [2.5, 2.4] }, adapter)
    let previous = 0
    for (const [minute, count] of [
      [10, 1],
      [20, 2],
      [25, 3],
      [30, 4],
      [40, 5],
      [50, 7],
      [60, 9],
    ] as const) {
      await vi.advanceTimersByTimeAsync((minute - previous) * 60000)
      await f.waitRecords('plugin:timeline/report', count)
      previous = minute
    }
    const reports = f.reports()
    const middle = reports.filter(report => report.level === 1)
    expect(middle.map(report => report.workMs)).toEqual([1200000, 1800000])
    expect(middle.map(report => report.children.length)).toEqual([2, 3])
    expect(Number(middle[1]?.createdAt) - Number(middle[0]?.createdAt)).toBe(1500000)
    expect(new Set(middle.flatMap(report => report.children)).size).toBe(5)
    expect(reports.at(-1)).toMatchObject({
      level: 2,
      workMs: 3000000,
      children: middle.map(report => report.id),
      ranges: [[reports[0]?.ranges?.[0]?.[0], middle.at(-1)?.end]],
    })
  })
  it('adds every level prompt to the global instructions, including the first level', async () => {
    const f = await running({
      summaryPrompt: 'Global stable instructions.',
      levelPrompts: ['First-level emphasis.', 'Higher-level emphasis.'],
      rollupFactors: [2],
    })
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 3)
    const questions = f.adapter.checks.map(request => JSON.stringify(request.messages))
    expect(questions[0]).toContain('Global stable instructions.')
    expect(questions[0]).toContain('First-level emphasis.')
    expect(questions[1]).toContain('Global stable instructions.')
    expect(questions[1]).toContain('Higher-level emphasis.')
    expect(questions[1]).not.toContain('Fix session recovery.')
  })
  it('uses 15-minute reports and 1-hour/4-hour rollups while retaining the one-minute floor', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await running({ intervalMs: 900000, rollupFactors: [4, 4] }, adapter)
    await vi.advanceTimersByTimeAsync(899999)
    expect(f.reports()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await f.waitRecords('plugin:timeline/report')
    for (let index = 2; index <= 16; index++) {
      await vi.advanceTimersByTimeAsync(900000)
      await f.waitRecords('plugin:timeline/report', index + Math.floor(index / 4) + (index === 16 ? 1 : 0))
    }
    expect(f.reports().filter(report => report.level === 0)).toHaveLength(16)
    expect(f.reports().filter(report => report.level === 1)).toHaveLength(4)
    expect(f.reports().at(-1)).toMatchObject({ level: 2, source: 'no-activity' })
    expect(adapter.checks).toHaveLength(0)
  })
  it('uses the synced app language in the task prompt and zero-activity summaries', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await running({ language: 'zh-CN' }, adapter)
    const prompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
    expect(prompt.sections.find(section => section.name === 'timeline:planning')?.text).toContain(
      "discussion replies in 简体中文. Follow the user's language instructions for all other work and conversation.",
    )
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(f.reports()[0]?.summary.progress).toEqual(['无活动。'])
    const references = f.plugin.effectiveConfig as PluginConfig
    updateVolatile(references.language, Config({ language: 'en' }).language)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 2)
    expect(f.reports()[1]?.summary.progress).toEqual(['No activity.'])
  })
  it('repairs one overlong draft without repeating the conversation or consuming another interval', async () => {
    const adapter = new Adapter()
    adapter.answers = [
      JSON.stringify({
        progress: [
          'This deliberately oversized report repeats the same review observation without adding evidence. '.repeat(
            4,
          ),
        ],
        uncertainties: [],
        userActions: [],
      }),
    ]
    const f = await running({}, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(f.reports()[0]?.summary).toEqual(summary)
    expect(adapter.checks).toHaveLength(2)
    expect(JSON.stringify(adapter.checks[1]?.messages)).toContain('Repair the draft')
    expect(JSON.stringify(adapter.checks[1]?.messages)).not.toContain('Fix session recovery.')
    expect(f.records.filter(event => event.type === 'plugin:timeline/request')).toHaveLength(2)
    expect(f.records.filter(event => event.type === 'plugin:timeline/failure')).toHaveLength(0)
  })
  it('waits for a backward wall clock without losing activity or writing reversed intervals', async () => {
    const f = await running()
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    const end = f.reports()[0]?.end
    expect(end).toBeDefined()
    const calls = f.adapter.checks.length
    vi.setSystemTime(Number(end) - 120000)
    await vi.advanceTimersByTimeAsync(60000)
    await settle()
    expect(f.reports()).toHaveLength(1)
    expect(f.adapter.checks).toHaveLength(calls)
    await vi.advanceTimersByTimeAsync(60000)
    await settle()
    expect(f.records.filter(event => event.type === 'plugin:timeline/failure')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 2)
    expect(f.reports()[1]).toMatchObject({ start: end, end: Number(end) + 60000 })
    expect(f.reports().every(report => report.end > report.start)).toBe(true)
  })
  it.each(['none', 'at the previous boundary', 'after the previous boundary'] as const)(
    'covers completed tool work while another tool is running; prior work %s',
    async (priorWork) => {
      const adapter = new Adapter()
      const f = await setup({}, adapter)
      fixtures.push(f)
      const started = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      f.ctx.tools.register(
        defineTool({
          name: 'slow_read',
          description: 'Read a delayed fixture',
          parameters: {},
          output: textOutput,
          execute: async (_args, exec) => {
            started.resolve(undefined)
            await untilReleased(release.promise, exec.signal)
            return 'Delayed read completed.'
          },
        }),
      )
      adapter.mainActions[priorWork === 'none' ? 0 : 1] = () => [{ name: 'slow_read', arguments: '{}' }]
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
      vi.setSystemTime(f.agent.session.header.createdAt + (priorWork === 'at the previous boundary' ? 0 : 1000))
      const partial = priorWork === 'after the previous boundary'
      const cutoff = Date.now()
      f.start()
      await started.promise
      await vi.advanceTimersByTimeAsync(60000)
      if (partial) {
        await f.waitRecords('plugin:timeline/report')
        expect(f.reports()[0]).toMatchObject({ end: cutoff, toolCount: 1, covered: 1 })
        const context = JSON.stringify(adapter.checks[0]?.messages)
        expect(context).toContain('Fixture read complete')
        expect(context).not.toContain('slow_read')
      } else {
        await settle()
        expect(f.reports()).toEqual([])
        expect(adapter.checks).toEqual([])
      }
      await vi.advanceTimersByTimeAsync(30000)
      release.resolve(undefined)
      await adapter.ready.promise
      if (partial) await vi.advanceTimersByTimeAsync(30000)
      await f.waitRecords('plugin:timeline/report', partial ? 2 : 1)
      expect(f.reports().at(-1)).toMatchObject({
        toolCount: priorWork === 'at the previous boundary' ? 2 : 1,
        covered: priorWork === 'none' ? 1 : 2,
      })
      expect(JSON.stringify(adapter.checks.at(-1)?.messages)).toContain('Delayed read completed.')
      if (partial) expect(f.reports().at(-1)?.start).toBe(cutoff)
    },
  )
  it('waits for the next complete snapshot when the surface changes without a new tool call', async () => {
    const f = await running()
    const session = f.agent.session
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Also check the saved results.' }],
    }), { surfaceOp: 'append' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.reports()).toEqual([])
    expect(f.adapter.checks).toEqual([])
  })
  it('uses the least intensive supported auxiliary effort while preserving the main task effort', async () => {
    const adapter = new Adapter()
    adapter.reasoning = {
      efforts: [
        { id: ReasoningEffortId('brief'), name: 'Brief' },
        { id: ReasoningEffortId('maximum'), name: 'Maximum' },
      ],
      defaultEffort: ReasoningEffortId('maximum'),
    }
    const f = await running({ reportReasoningEffort: 'brief', reportMaxTokens: 512 }, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(adapter.main.at(-1)?.reasoningEffort).toBe('maximum')
    expect(adapter.checks[0]?.reasoningEffort).toBe('brief')
    expect(adapter.checks[0]?.maxTokens).toBe(512)
  })
  it('rejects an explicit unsupported report effort before recording or dispatching a request', async () => {
    const f = await running({ reportReasoningEffort: 'unavailable' })
    await vi.advanceTimersByTimeAsync(60000)
    await vi.waitFor(() => {
      expect(f.records.some(record =>
        record.type === 'plugin:timeline/request' || record.type === 'plugin:timeline/failure',
      )).toBe(true)
    })
    expect(f.adapter.checks).toHaveLength(0)
    await f.waitRecords('plugin:timeline/failure')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.error).toContain('unavailable')
    expect(f.records.some(record => record.type === 'plugin:timeline/request')).toBe(false)
    expect(f.agent.status).toBe('running')
  })
  it('reports one tool call without a viewer or a workload threshold, and leaves the main task running', async () => {
    const f = await running()
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(f.reports()[0]?.summary).toEqual(summary)
    expect(f.reports()[0]?.toolCount).toBe(1)
    expect(f.adapter.checks).toHaveLength(1)
    expect(f.agent.status).toBe('running')
    const request = f.records.find(record => record?.type === 'plugin:timeline/request')
    const recorded = requestRecordSchema.parse(request?.data)
    expect(recorded.prefixLength).toBeGreaterThan(0)
    const session = f.agent.session
    const replay = Session.create(
      session.id, session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(recorded.contextSeq + 1)), session.header,
    )
    const suffix = recorded.request as { messages: unknown[]; purpose: string }
    expect(suffix.purpose).toBe('timeline-report')
    expect([...replay.deriveMessages().slice(0, recorded.prefixLength), ...suffix.messages]).toEqual(
      f.adapter.checks[0]?.messages,
    )
  })
  it('keeps tool results as report context without offering the main task tools to the summarizer', async () => {
    const f = await running()
    const main = f.adapter.main.at(-1)
    const original = JSON.stringify(main)
    expect(main?.tools?.some(tool => tool.name === 'echo')).toBe(true)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    const request = f.adapter.checks[0]
    expect(JSON.stringify(request?.messages)).toContain('Fixture read complete')
    expect(request?.tools).toBeUndefined()
    expect(request?.toolHistory).toBeUndefined()
    expect(JSON.stringify(f.adapter.main.at(-1))).toBe(original)
    expect(f.agent.status).toBe('running')
  })
  it('bounds response content without charging repeated JSON framing for tiny stream deltas', async () => {
    const adapter = new Adapter()
    adapter.tinyDeltas = true
    const f = await running({ maxResponseBytes: Buffer.byteLength(adapter.answer) + 128 }, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(f.reports()[0]?.summary).toEqual(summary)
  })
  it('hard-codes no activity without calling the model, including later empty intervals', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await running({}, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(f.reports()[0]).toMatchObject({
      source: 'no-activity',
      toolCount: 0,
      summary: { progress: ['No activity.'] },
    })
    expect(adapter.checks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 2)
    expect(f.reports()).toHaveLength(2)
    expect(adapter.checks).toHaveLength(0)
  })
  it('rolls completed children up and avoids model calls for an entirely quiet hierarchy', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await running({ rollupFactors: [2, 2] }, adapter)
    for (const count of [1, 3, 4, 7]) {
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report', count)
    }
    expect(f.reports().map(report => report.level)).toEqual([0, 0, 1, 0, 0, 1, 2])
    expect(f.reports().at(-1)?.children).toHaveLength(2)
    expect(adapter.checks).toHaveLength(0)
  })
  it('uses the editable prompt for base reports and rollups', async () => {
    const f = await running({ summaryPrompt: 'Custom short report instructions.', rollupFactors: [2] })
    for (const count of [1, 3]) {
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report', count)
    }
    expect(f.adapter.checks).toHaveLength(2)
    expect(
      f.adapter.checks.every(request =>
        JSON.stringify(request.messages).includes('Custom short report instructions.'),
      ),
    ).toBe(true)
    expect(f.reports().map(report => report.level)).toEqual([0, 0, 1])
  })
  it('uses the current plugin language for both report levels without changing or forking the working agent', async () => {
    const f = await running({ rollupFactors: [2], levelPrompts: ['', 'Combine the child results.'] })
    const original = structuredClone(f.adapter.main.at(-1)?.messages)
    const references = f.plugin.effectiveConfig as PluginConfig
    updateVolatile(references.language, Config({ language: 'zh-CN' }).language)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    const base = f.adapter.checks[0]
    expect(JSON.stringify(base?.messages)).toContain('Fix session recovery.')
    expect(JSON.stringify(base?.messages.at(-1))).toContain(
      'All titles, descriptions, user-facing texts must be written in 简体中文.',
    )
    expect(base?.messages.slice(0, -1)).toEqual(original)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 3)
    expect(f.reports()[1]?.summary.progress).toEqual(['无活动。'])
    const rollup = f.adapter.checks.at(-1)
    expect(rollup?.system).toContain('written in 简体中文.')
    expect(rollup?.messages).toHaveLength(1)
    expect(JSON.stringify(rollup?.messages)).toContain('Combine the child results.')
    expect(rollup?.messages[0]?.content.find(block => block.type === 'text')?.text).toContain('"start"')
    expect(JSON.stringify(rollup?.messages)).not.toContain('Fix session recovery.')
    expect(f.adapter.main.at(-1)?.messages).toEqual(original)
    expect(f.ctx.agents.list()).toHaveLength(1)
  })
  it('summarizes mixed children even after a surface event invalidates the base snapshot', async () => {
    const f = await running({ rollupFactors: [2], levelPrompts: ['', 'Condense child reports.'] })
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    f.agent.session.append(
      'user/message',
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Continue the review.' }],
      }),
      { surfaceOp: 'append' },
    )
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 3)
    expect(f.records.filter(record => record?.type === 'plugin:timeline/failure')).toEqual([])
    expect(f.reports().map(report => [report.level, report.source])).toEqual([
      [0, 'model'],
      [0, 'no-activity'],
      [1, 'model'],
    ])
    const rollup = f.adapter.checks.at(-1)
    expect(rollup?.messages).toHaveLength(1)
    expect(JSON.stringify(rollup?.messages)).toContain('Condense child reports.')
    expect(JSON.stringify(rollup?.messages)).not.toContain('Fix session recovery.')
    expect(f.reports().at(-1)?.children).toHaveLength(2)
  })
  it('keeps live settings references and applies cadence and prompt changes to subsequent work', async () => {
    const f = await running({ rollupFactors: [2] })
    const references = f.plugin.effectiveConfig as PluginConfig
    const changed = Config({
      intervalMs: 120000,
      rollupFactors: [2],
      summaryPrompt: 'New concise prompt.',
      levelPrompts: ['', 'New rollup instructions.'],
    })
    updateVolatile(references.intervalMs, changed.intervalMs)
    updateVolatile(references.summaryPrompt, changed.summaryPrompt)
    updateVolatile(references.levelPrompts, changed.levelPrompts)
    await vi.advanceTimersByTimeAsync(119999)
    expect(f.reports()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await f.waitRecords('plugin:timeline/report')
    expect(JSON.stringify(f.adapter.checks[0]?.messages)).toContain('New concise prompt.')
    await vi.advanceTimersByTimeAsync(119999)
    expect(f.reports()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await f.waitRecords('plugin:timeline/report', 3)
    expect(
      f
        .reports()
        .filter(report => report.level === 0)
        .map(report => report.workMs),
    ).toEqual([120000, 120000])
    expect(JSON.stringify(f.adapter.checks.at(-1)?.messages)).toContain('New rollup instructions.')
    expect(f.reports().every(report => report.policy === '[120000,2]')).toBe(true)
    expect(f.reports().at(-1)?.workMs).toBe(240000)
  })
  it('retries a malformed response at the next interval without consuming the activity watermark', async () => {
    const adapter = new Adapter()
    adapter.answer = 'not JSON'
    const f = await running({}, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/failure')
    expect(f.reports()).toHaveLength(0)
    expect(adapter.checks).toHaveLength(2)
    expect(f.records.some(record => record?.type === 'plugin:timeline/failure')).toBe(true)
    adapter.answer = JSON.stringify(summary)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report')
    expect(f.reports()[0]?.toolCount).toBe(1)
    expect(f.reports()[0]?.workMs).toBe(120000)
    expect(adapter.checks).toHaveLength(3)
  })
  it('waits for an admitted model route before rolling up saved model reports', async () => {
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await setup({ rollupFactors: [2] }, adapter)
    fixtures.push(f)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const session = f.agent.session
    const end = Date.now() + 1
    const report = reportSchema.parse({
      id: 'saved-model', level: 0, start: end - 60000, end, policy: '[60000,2]', children: [],
      source: 'model', toolCount: 1, covered: 0, contextSeq: 0, summary,
    })
    await f.ctx.timeline.append(session, 'plugin:timeline/report', { version: 1, sessionId: session.id, report })
    await vi.advanceTimersByTimeAsync(60001)
    const admitted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const off = f.agent.ctx.on('agent/request', async (_input, next) => {
      admitted.resolve(undefined)
      await release.promise
      return next()
    }, { prepend: true })
    try {
      f.start()
      await admitted.promise
      await f.waitRecords('plugin:timeline/report', 2)
      expect(f.reports().map(report => report.level)).toEqual([0, 0])
      expect(adapter.checks).toEqual([])
      release.resolve(undefined)
      await f.waitRecords('plugin:timeline/report', 3)
      expect(f.reports().at(-1)).toMatchObject({ level: 1, children: ['saved-model', expect.any(String)] })
      expect(adapter.checks).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      off()
    }
  })
  it('rolls up saved reports whose older records lack generation and activity times', async () => {
    const adapter = new Adapter()
    const f = await setup({ rollupFactors: [2] }, adapter)
    fixtures.push(f)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const session = f.agent.session
    const end = Date.now() + 60000
    const save = async (id: string, level: number, start: number, end: number, children: string[]) => {
      const report = reportSchema.parse({
        id, level, start, end, policy: '[60000,2]', children, source: 'no-activity',
        toolCount: 0, covered: 0, contextSeq: 0, summary,
      })
      await f.ctx.timeline.append(session, 'plugin:timeline/report', { version: 1, sessionId: session.id, report })
    }
    await save('old-base', 0, end - 120000, end - 60000, [])
    await save('old-rollup', 1, end - 120000, end - 60000, ['old-base'])
    await save('new-base', 0, end - 60000, end, [])
    await vi.advanceTimersByTimeAsync(120000)
    f.start()
    await adapter.ready.promise
    await f.waitRecords('plugin:timeline/report', 5)
    expect(f.reports().at(-1)).toMatchObject({ level: 1, workMs: 60000, children: ['new-base', expect.any(String)] })
    expect(f.reports().at(-1)?.ranges).toEqual([])
    expect(adapter.checks).toHaveLength(2)
  })
  it('commits a buffered report once when a report flush fails before recovery', async () => {
    const f = await running({ rollupFactors: [2] })
    let failed = false
    f.ctx.on('session/flush', (session) => {
      if (session === f.agent.session && f.reports().length === 1 && !failed) {
        failed = true
        throw new Error('Temporary report flush failure')
      }
    })
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/failure')
    const first = f.reports()[0]
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 3)
    const bases = f.reports().filter(report => report.level === 0)
    expect(bases).toHaveLength(2)
    expect(bases[1]).toMatchObject({ start: first?.end, toolCount: 0, workMs: 60000 })
    expect(f.reports().at(-1)?.workMs).toBe(120000)
    expect(f.adapter.checks).toHaveLength(2)
  })
  it('counts main work during an auxiliary query toward the next report', async () => {
    const adapter = new Adapter()
    adapter.checkRelease = Promise.withResolvers<undefined>()
    const f = await running({}, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await adapter.checkStarted.promise
    await vi.advanceTimersByTimeAsync(30000)
    adapter.checkRelease.resolve(undefined)
    await f.waitRecords('plugin:timeline/report')
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 2)
    expect(f.reports().map(report => report.workMs)).toEqual([60000, 90000])
    expect(f.reports()[0]?.createdAt).toBe(Number(f.reports()[0]?.end) + 30000)
  })
  it('aborts and drains a summary when the plugin unloads', async () => {
    const adapter = new Adapter()
    adapter.checkRelease = Promise.withResolvers<undefined>()
    const f = await running({}, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await adapter.checkStarted.promise
    expect(adapter.active).toBe(1)
    await f.plugin.dispose()
    expect(adapter.active).toBe(0)
    await vi.advanceTimersByTimeAsync(600000)
    expect(adapter.checks).toHaveLength(1)
  })
  it.each([1, 4])(
    'catches up due levels after %ih idle without counting idle time as work',
    async (hours) => {
      const f = await running({ intervalMs: 900000, rollupFactors: [4, 4] })
      const start = Date.now()
      await vi.advanceTimersByTimeAsync(24000)
      f.adapter.release.resolve(undefined)
      await f.agent.whenIdle()
      await vi.advanceTimersByTimeAsync(hours * 3600000)
      expect(f.reports()).toHaveLength(0)
      expect(f.adapter.checks).toHaveLength(0)
      f.adapter.release = Promise.withResolvers<undefined>()
      f.adapter.ready = Promise.withResolvers<undefined>()
      f.start()
      await f.adapter.ready.promise
      const levels = hours === 1 ? [0, 1] : [0, 1, 2]
      await f.waitRecords('plugin:timeline/report', levels.length)
      expect(f.reports().map(report => report.level)).toEqual(levels)
      expect(f.reports()[0]?.toolCount).toBe(1)
      for (const report of f.reports()) {
        expect(report.workMs).toBe(24000)
        expect(report.ranges).toEqual([[start, start + 24000]])
        expect(report.createdAt).toBe(start + 24000 + hours * 3600000)
      }
      expect(f.agent.status).toBe('running')
      await settle()
      expect(f.reports()).toHaveLength(levels.length)
    },
  )
  it('reconciles uncovered work across a plugin reload and keeps captured report ranges stable', async () => {
    const f = await running({ rollupFactors: [2] })
    const start = Date.now()
    await vi.advanceTimersByTimeAsync(24000)
    f.adapter.release.resolve(undefined)
    await f.agent.whenIdle()
    await f.plugin.dispose()
    await vi.advanceTimersByTimeAsync(3600000)
    await f.ctx.plugin(Timeline, { intervalMs: 60000, rollupFactors: [2] })
    f.adapter.release = Promise.withResolvers<undefined>()
    f.adapter.ready = Promise.withResolvers<undefined>()
    f.start()
    await f.adapter.ready.promise
    await f.waitRecords('plugin:timeline/report', 2)
    const first = f.reports()[0]
    expect(first).toMatchObject({
      toolCount: 1,
      workMs: 24000,
      ranges: [[start, start + 24000]],
    })
    expect(first?.id).toMatch(/^report-[0-9a-f]{16}$/u)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 3)
    expect(f.reports()[0]).toEqual(first)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 5)
    expect(f.reports().at(-1)).toMatchObject({
      level: 1,
      workMs: 120000,
      ranges: [[start + 3624000, start + 3744000]],
    })
  })
  it('retries a failed rollup before another base report is due', async () => {
    const f = await running({ intervalMs: 600000, rollupFactors: [2.5] })
    for (const count of [1, 2]) {
      await vi.advanceTimersByTimeAsync(600000)
      await f.waitRecords('plugin:timeline/report', count)
    }
    f.adapter.fail = true
    await vi.advanceTimersByTimeAsync(300000)
    await f.waitRecords('plugin:timeline/failure')
    expect(f.reports().map(report => report.level)).toEqual([0, 0])
    f.adapter.fail = false
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.reports()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await f.waitRecords('plugin:timeline/report', 3)
    expect(f.reports().map(report => report.level)).toEqual([0, 0, 1])
    expect(f.reports().at(-1)?.children).toEqual(
      f
        .reports()
        .slice(0, 2)
        .map(report => report.id),
    )
    expect(f.adapter.checks).toHaveLength(3)
    expect(f.ctx.timeline.stateOf(f.agent.session).view.error).toBeNull()
  })
  it('restores successful thresholds and uncovered short work in a fresh Host', async () => {
    const config = { intervalMs: 900000, rollupFactors: [4, 4] }
    const f = await running(config)
    await vi.advanceTimersByTimeAsync(900000)
    await f.waitRecords('plugin:timeline/report')
    const first = f.reports()[0]
    f.adapter.release.resolve(undefined)
    await f.agent.whenIdle()
    f.adapter.mainActions[2] = () => [{ name: 'echo', arguments: '{}' }]
    f.adapter.ready = Promise.withResolvers<undefined>()
    f.adapter.release = Promise.withResolvers<undefined>()
    f.start()
    await f.adapter.ready.promise
    await vi.advanceTimersByTimeAsync(24000)
    f.adapter.release.resolve(undefined)
    await f.agent.whenIdle()
    const restore = { root: f.root, sessionId: f.agent.session.id }
    await f.close({ preserve: true })
    fixtures.splice(fixtures.indexOf(f), 1)
    await vi.advanceTimersByTimeAsync(4 * 3600000)
    const adapter = new Adapter()
    adapter.calls = 0
    const next = await setup(config, adapter, restore)
    fixtures.push(next)
    expect(next.reports()).toEqual([first])
    expect(adapter.checks).toHaveLength(0)
    next.start()
    await adapter.ready.promise
    await next.waitRecords('plugin:timeline/report', 4)
    expect(next.reports()[0]).toEqual(first)
    expect(next.reports().map(report => report.level)).toEqual([0, 0, 1, 2])
    expect(next.reports()[1]).toMatchObject({ toolCount: 1, workMs: 24000 })
    expect(next.reports().at(-1)).toMatchObject({ toolCount: 2, workMs: 924000 })
    expect(adapter.checks).toHaveLength(3)
    expect(JSON.stringify(adapter.checks[0]?.messages)).toContain('Fixture read complete')
    await vi.advanceTimersByTimeAsync(59999)
    expect(next.reports()).toHaveLength(4)
  })
  it('schedules reports only for agents in the plugin scope', async () => {
    const f = await setup({}, new Adapter())
    fixtures.push(f)
    await f.plugin.dispose()
    const parent = {}
    await createScope(f.ctx, parent).ctx.plugin(Timeline, { intervalMs: 60000 })
    const inside = await f.ctx.agents.create({
      sessionId: SessionId('inside-timeline-scope'),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'fixture', model: 'timeline' },
    })
    bindScopeParent(inside.agent, parent)
    expect(f.ctx.tools.get('timeline_tree', inside.agent)).toBeDefined()
    expect(f.ctx.tools.get('timeline_tree', f.agent)).toBeUndefined()
    const worker = await f.ctx.agents.create({
      sessionId: SessionId('outside-timeline-worker'),
      meta: { origin: 'subagent' },
    })
    bindScopeParent(worker.agent, {})
    expect(f.ctx.tools.get('timeline_tree', worker.agent)).toBeUndefined()
    f.ctx.emit('tools/change')
    expect(f.ctx.tools.get('timeline_tree', worker.agent)).toBeUndefined()
    await worker.dispose()
    const outside = await f.ctx.agents.create({ sessionId: SessionId('outside-timeline-scope') })
    await outside.dispose()
    expect(inside.agent.ctx.get('timeline')?.available(inside.agent.session)).toBe(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    f.start()
    inside.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review inside the preset.' }] }))
    await f.adapter.waitForMain(4)
    await vi.advanceTimersByTimeAsync(60000)
    await f.adapter.checkStarted.promise
    expect(f.adapter.checks.map(request => request.sessionId)).toEqual([inside.agent.session.id])
  })
  it('writes a scoped agent report only once when a root installation also exists', async () => {
    const f = await setup({ intervalMs: 60000 })
    fixtures.push(f)
    const parent = {}
    const scoped = await createScope(f.ctx, parent).ctx.isolate('timeline').plugin(Timeline, { intervalMs: 60000 })
    try {
      const { agent } = await f.ctx.agents.create({
        sessionId: SessionId('timeline-shared-projection'),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: 'fixture', model: 'timeline' },
      })
      bindScopeParent(agent, parent)
      expect(f.ctx.tools.get('timeline_tree', agent)).not.toBe(f.ctx.tools.get('timeline_tree', f.agent))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review inside the preset.' }] }))
      await f.adapter.waitForMain(2)
      await vi.advanceTimersByTimeAsync(60000)
      await f.waitRecords('plugin:timeline/report', 1, agent.session.id)
      expect(f.adapter.checks.map(request => request.sessionId)).toEqual([agent.session.id])
      expect(f.ctx.timeline.stateOf(agent.session).view.reports).toHaveLength(1)
    } finally {
      await scoped.dispose()
    }
  })
  it('rolls up quiet children after a live reload without needing another model request', async () => {
    const config = { intervalMs: 600000, rollupFactors: [2.5] }
    const adapter = new Adapter()
    adapter.calls = 0
    const f = await running(config, adapter)
    for (const count of [1, 2]) {
      await vi.advanceTimersByTimeAsync(600000)
      await f.waitRecords('plugin:timeline/report', count)
    }
    await vi.advanceTimersByTimeAsync(240000)
    await f.plugin.dispose()
    await f.ctx.plugin(Timeline, config)
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:timeline/report', 3)
    expect(f.reports().map(report => report.level)).toEqual([0, 0, 1])
    expect(f.reports().at(-1)).toMatchObject({ source: 'no-activity', workMs: 1200000 })
    expect(adapter.checks).toHaveLength(0)
  })
  it('does not report a quiet Session merely because it is opened or the plugin reloads', async () => {
    const f = await setup({ intervalMs: 900000, rollupFactors: [4, 4] })
    fixtures.push(f)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    await vi.advanceTimersByTimeAsync(8 * 3600000)
    await f.plugin.dispose()
    await f.ctx.plugin(Timeline, { intervalMs: 900000, rollupFactors: [4, 4] })
    await vi.advanceTimersByTimeAsync(8 * 3600000)
    expect(f.reports()).toHaveLength(0)
    expect(f.adapter.checks).toHaveLength(0)
    expect(f.agent.status).toBe('idle')
    expect(f.ctx.timeline.stateOf(f.agent.session).view.error).toBeNull()
  })
  it('records a timeout and drains the canceled auxiliary stream', async () => {
    const adapter = new Adapter()
    adapter.checkRelease = Promise.withResolvers<undefined>()
    const f = await running({ timeoutMs: 50 }, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await adapter.checkStarted.promise
    await vi.advanceTimersByTimeAsync(50)
    await f.waitRecords('plugin:timeline/failure')
    expect(adapter.active).toBe(0)
    expect(f.reports()).toHaveLength(0)
  })
  it('does not rearm a disposed Agent after its independent report settles', async () => {
    const adapter = new Adapter()
    adapter.checkRelease = Promise.withResolvers<undefined>()
    const f = await running({}, adapter)
    await vi.advanceTimersByTimeAsync(60000)
    await adapter.checkStarted.promise
    await f.disposeAgent()
    await settle()
    expect(adapter.active).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds concurrent summaries queued by multiple Sessions', async () => {
    const adapter = new Adapter()
    adapter.checkRelease = Promise.withResolvers<undefined>()
    const f = await running({ maxConcurrent: 1 }, adapter)
    const others = await Promise.all(
      ['second', 'third'].map(async (id) => {
        const agent = await f.harness.create(SessionId(id), { provider: 'fixture', model: 'timeline' })
        const handle = await f.ctx.sessionPersistence.open(agent.session.id, 'read')
        agent.followup(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'Check session recovery.' }],
          }),
        )
        return { agent, handle }
      }),
    )
    try {
      await adapter.waitForMain(6)
      await vi.advanceTimersByTimeAsync(60000)
      await adapter.checkStarted.promise
      adapter.checkRelease.resolve(undefined)
      await Promise.all(
        others.map(({ agent }) => f.waitRecords('plugin:timeline/report', 1, agent.session.id)),
      )
      expect(adapter.peak).toBe(1)
      expect(adapter.checks).toHaveLength(3)
    } finally {
      for (const { handle } of others) await handle.close()
    }
  })
})
