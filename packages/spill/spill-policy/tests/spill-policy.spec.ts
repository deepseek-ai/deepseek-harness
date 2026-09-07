/**
 * Tests for the spill-policy PLUGIN. It registers no service, only the
 * `tools/post-execute` transformer. We drive real tools through
 * `ctx.tools.execute(...)` and assert: disabled mode is a true no-op, an
 * oversized plain-text result is spilled and replaced with a preview + locator,
 * a small result and a non-text result pass through, `read` is skipped, and a
 * `saveText` failure / missing backend / missing owner all preserve the original
 * result without an `isError`.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { WorkerThreadCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker-thread'

const testToolSignal = new AbortController().signal

/** A stub spill backend recording its saves; `fail` exercises the best-effort fallback. */
class StubStore extends SpillStore {
  saves: SaveTextSpill[] = []
  fail = false
  /** Per-save hang hook: each call awaits the returned promise before completing. */
  gate: (() => Promise<void>) | undefined

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.fail) throw new Error('disk full')
    await this.gate?.()
    this.saves.push(input)
    return {
      locator: SpillLocator(`/spill/${input.suggestedName}`),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use the stub retrieval path.',
    }
  }
}

/** A tool returning `text` verbatim (name configurable so we can register `read`). */
function textTool(name: string, text: string) {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text }] },
  })
}

/** A minimal exec carrying a session header id (the spill owner). */
function exec(name: string, session = 's1'): ToolExecution {
  // Only agent.session.header.id is read by the policy; a structural stub suffices.
  const agent = { session: { header: { id: SessionId(session) } } }
  return { callId: ToolCallId(`call-${name}`), name, arguments: {}, agent, signal: testToolSignal } as unknown as ToolExecution
}

/**
 * Build a context with tools + the policy, and optionally a spill backend.
 * Returns the context and the backend handle (undefined when `withSpill` false).
 */
async function setup(
  config: SpillPolicy.Config,
  withSpill = true,
  beforePolicy?: (ctx: Context) => void,
): Promise<{ ctx: Context; spill?: StubStore; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let spill: StubStore | undefined
  if (withSpill) {
    await ctx.plugin(StubStore)
    spill = ctx.spillStore as StubStore
  }
  beforePolicy?.(ctx)
  const fiber = await ctx.plugin(SpillPolicy, config)
  return { ctx, fiber, ...spill ? { spill } : {} }
}

/** Flatten a result's text blocks. */
function textOf(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

describe('disabled mode', () => {
  it('registers no post-execute listener when maxInlineBytes is omitted', async () => {
    const { ctx, spill } = await setup({})
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(result.isError).toBe(false)
    expect(spill?.saves).toHaveLength(0)
  })
})

describe('loader export shape', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in SpillPolicy).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(SpillPolicy) as Record<string, unknown>
    expect(unwrapped).toBe(SpillPolicy)
    expect(unwrapped.name).toBe('spill-policy')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})

describe('config validation', () => {
  it('rejects a negative maxInlineBytes at load', async () => {
    await expect(setup({ maxInlineBytes: -1 })).rejects.toThrow(/non-negative integer/)
  })

  it('rejects a fractional maxInlineBytes at load', async () => {
    await expect(setup({ maxInlineBytes: 1.5 })).rejects.toThrow(/non-negative integer/)
  })

})

describe('oversized plain-text replacement', () => {
  it('spills the full text and replaces the result with a preview + locator within the cap', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 200 })
    const body = 'HEAD'.repeat(200) + 'TAIL'.repeat(200) // 1600 bytes > 200
    ctx.tools.register(textTool('big', body))
    const result = await ctx.tools.execute(exec('big'))

    expect(result.isError).toBe(false)
    expect(spill?.saves).toHaveLength(1)
    expect(spill?.saves[0]?.content).toBe(body)
    expect(spill?.saves[0]?.source).toMatchObject({ toolName: 'big' })
    expect(spill?.saves[0]?.suggestedName).toBe('big.txt')
    expect(spill?.saves[0]?.owner.sessionId).toBe('s1')

    const text = textOf(result.content)
    expect(text).not.toBe(body)
    expect(text.startsWith('HEAD')).toBe(true)
    expect(text).toContain('Full formatted result stored at: /spill/big.txt')
    expect(text).toContain('Use the stub retrieval path.')
    expect(text).toContain('Omitted')
    // The replacement (preview + blank line + notice) stays within the cap and
    // is smaller than the original — the whole point of spilling.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(body.length)
  })

  it('keeps the inline result when the notice-only replacement would exceed the cap', async () => {
    // A body just over a tiny cap: the notice alone is larger than the cap, so
    // there is no within-cap replacement — the policy keeps the inline result.
    const { ctx } = await setup({ maxInlineBytes: 4 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const body = 'xxxxx' // 5 bytes > 4, but far shorter than the notice
    ctx.tools.register(textTool('big', body))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe(body)
    expect(warn).toHaveBeenCalled()
  })

  it('leaves a small plain-text result unchanged', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 1000 })
    ctx.tools.register(textTool('small', 'tiny'))
    const result = await ctx.tools.execute(exec('small'))
    expect(textOf(result.content)).toBe('tiny')
    expect(spill?.saves).toHaveLength(0)
  })

  it('leaves a result with a non-text block unchanged', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 5 })
    ctx.tools.register(defineContentToolFixture({
      name: 'mixed',
      description: 'mixed',
      parameters: {},
      async execute(): Promise<ContentBlock[]> {
        return [{ type: 'text', text: 'x'.repeat(100) }, { type: 'reasoning', text: 'why' }]
      },
    }))
    const result = await ctx.tools.execute(exec('mixed'))
    expect(spill?.saves).toHaveLength(0)
    expect(result.content).toHaveLength(2)
  })
})

describe('outer PTC mode failure capture', () => {
  it('spills the bounded output-limit diagnostic through the ordinary outer-result policy', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    await ctx.plugin(StubStore)
    await ctx.plugin(SpillPolicy, { maxInlineBytes: 200 })
    await ctx.plugin(WorkerThreadCodeRuntime, { maxOutputBytes: 500 })
    const events: unknown[] = []
    const agent = {
      session: {
        header: { id: SessionId('code-spill'), cwd: '/workspace' },
        append: (_type: string, data: unknown) => { events.push(data) },
      },
    }

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('code-output-limit'),
      name: 'run_code',
      arguments: {
        code: 'console.log("HEAD-" + "x".repeat(300)); console.log("TAIL-" + "y".repeat(300)); return "unreachable";',
        description: 'Print oversized head and tail lines',
      },
      agent: agent as never,
    })

    expect(result.isError).toBe(true)
    const saved = (ctx.spillStore as StubStore).saves
    expect(saved).toHaveLength(1)
    expect(saved[0]?.source).toMatchObject({ toolName: 'run_code' })
    expect(saved[0]?.content).toContain('code run failed (output-limit)')
    expect(saved[0]?.content).toContain('HEAD-')
    expect(textOf(result.content)).toContain('Full formatted result stored at: /spill/run_code.txt')
    expect(events).toEqual([])
  })
})

describe('read skip', () => {
  it('never spills the read tool result (avoids a read → spill → read loop)', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 10 })
    ctx.tools.register(textTool('read', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('read'))
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(spill?.saves).toHaveLength(0)
  })
})

describe('the durable dispatch-log arm', () => {
  /** Boot code mode + the policy + the worker runtime; run one program via the real bridge. */
  async function runCodeWith(program: string, maxInlineBytes: number, extraTools: ToolDefinition[] = []) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    await ctx.plugin(StubStore)
    await ctx.plugin(SpillPolicy, { maxInlineBytes })
    await ctx.plugin(WorkerThreadCodeRuntime, {})
    const events: { type: string; data: unknown }[] = []
    const agent = {
      session: {
        header: { id: SessionId('dispatch-spill'), cwd: '/workspace' },
        append: (type: string, data: unknown) => { events.push({ type, data }) },
      },
    }
    ctx.tools.register(textTool('huge_read', 'H'.repeat(2_000)))
    ctx.tools.register(textTool('small_read', 'tiny'))
    for (const tool of extraTools) ctx.tools.register(tool)
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('parent-1'),
      name: 'run_code',
      arguments: { code: program, description: 'Drive dispatch-log spilling' },
      agent: agent as never,
    })
    return { ctx, result, events, spill: ctx.spillStore as StubStore }
  }

  it('bounds the tool/code-dispatch copy of an oversized sub-result while the program value stays whole', async () => {
    const { result, events, spill } = await runCodeWith(
      'const blocks = await tools.huge_read({});\nreturn blocks[0].text.length', 200)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    // The program received the COMPLETE text (length 2000), untouched by spill.
    expect(result.value).toMatchObject({ result: 2_000 })
    // The durable settle event carries the bounded projection + locator.
    const settle = events.find(event => event.type === 'tool/code-dispatch')
    expect(settle).toBeDefined()
    const logged = (settle!.data as { content: { type: string; text: string }[] }).content
    expect(logged).toHaveLength(1)
    const loggedText = logged[0]!.text
    expect(Buffer.byteLength(loggedText, 'utf8')).toBeLessThanOrEqual(200)
    expect(loggedText).toContain('Full formatted result stored at: /spill/huge_read.txt')
    // The artifact holds the full text under the dispatch label and sub-call id.
    const save = spill.saves.find(entry => entry.source.label === 'dispatch')
    expect(save).toMatchObject({
      source: { kind: 'tool', toolName: 'huge_read', callId: 'parent-1:code:1', label: 'dispatch' },
    })
    expect(save?.content).toBe('H'.repeat(2_000))
  })

  it('leaves a non-text sub-result log unchanged (flatten declines)', async () => {
    const { events, spill } = await runCodeWith(
      'return await tools.mixed_read({})', 5, [defineContentToolFixture({
        name: 'mixed_read',
        description: 'mixed_read',
        parameters: {},
        async execute(): Promise<ContentBlock[]> {
          return [{ type: 'text', text: 'x'.repeat(100) }, { type: 'reasoning', text: 'why' }]
        },
      })])
    const settle = events.find(event => event.type === 'tool/code-dispatch')
    expect((settle!.data as { content: unknown[] }).content).toHaveLength(2)
    expect(spill.saves.filter(entry => entry.source.label === 'dispatch')).toHaveLength(0)
  })

  it('leaves a within-cap sub-result log untouched and saves nothing for it', async () => {
    const { events, spill } = await runCodeWith(
      'return await tools.small_read({})', 200)
    const settle = events.find(event => event.type === 'tool/code-dispatch')
    expect((settle!.data as { content: { type: string; text: string }[] }).content)
      .toEqual([{ type: 'text', text: 'tiny' }])
    expect(spill.saves.filter(entry => entry.source.label === 'dispatch')).toHaveLength(0)
  })

  it('a slow spill backend never delays the program value or a later dispatch slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    await ctx.plugin(StubStore)
    await ctx.plugin(SpillPolicy, { maxInlineBytes: 100 })
    await ctx.plugin(WorkerThreadCodeRuntime, {})
    // A spill backend that hangs until released.
    let releaseSave!: () => void
    const gate = new Promise<void>((resolve) => { releaseSave = resolve })
    const store = ctx.spillStore as StubStore
    const realSave = store.saveText.bind(store)
    store.saveText = async (input) => {
      await gate
      return realSave(input)
    }
    const events: { type: string; data: unknown }[] = []
    const agent = {
      session: {
        header: { id: SessionId('dispatch-slow-spill'), cwd: '/workspace' },
        append: (type: string, data: unknown) => { events.push({ type, data }) },
      },
    }
    ctx.tools.register(textTool('huge_read', 'H'.repeat(2_000)))
    ctx.tools.register(textTool('small_read', 'tiny'))
    let smallAfterHuge = false
    const runPromise = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('parent-3'),
      name: 'run_code',
      arguments: {
        // The program takes BOTH values while the spill backend hangs: the
        // huge read's binding resolves immediately (its logged copy is side
        // work), so the small read proceeds without waiting.
        code: 'const big = await tools.huge_read({});\nconst small = await tools.small_read({});\nreturn big[0].text.length + small[0].text.length',
        description: 'Prove log shaping is off the program path',
      },
      agent: agent as never,
    }).then((result) => {
      return result
    })
    // The run cannot COMPLETE while the settle append is gated (drain waits
    // for logWork), but the program itself already ran both calls; release
    // the backend and observe the settle events land inside the turn.
    await vi.waitFor(() => {
      // The second dispatch STARTED while the first one's spill hung.
      smallAfterHuge = events.some(event => event.type === 'tool/code-dispatch-start'
        && (event.data as { name: string }).name === 'small_read')
      if (!smallAfterHuge) throw new Error('small_read not started yet')
    })
    releaseSave()
    const result = await runPromise
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ result: 2_004 })
    const settles = events.filter(event => event.type === 'tool/code-dispatch')
    expect(settles).toHaveLength(2)
    expect(smallAfterHuge).toBe(true)
  })

  it('a sustained slow backend backpressures the run instead of accumulating unbounded log tasks', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    // Cap 1: once the hung shaped-append backlog exceeds the cap, the ordered
    // lane holds inside the second commit, so the THIRD dispatch cannot start
    // until a pending save drains — the bound is observable as its missing
    // start event.
    await ctx.plugin(ToolRuntime, { mode: 'ptc', maxParallelSubCalls: 1 })
    await ctx.plugin(StubStore)
    await ctx.plugin(SpillPolicy, { maxInlineBytes: 100 })
    await ctx.plugin(WorkerThreadCodeRuntime, {})
    const store = ctx.spillStore as StubStore
    const releases: (() => void)[] = []
    store.gate = () => new Promise<void>((resolve) => { releases.push(resolve) })
    const events: { type: string; data: unknown }[] = []
    const agent = {
      session: {
        header: { id: SessionId('dispatch-spill-bound'), cwd: '/workspace' },
        append: (type: string, data: unknown) => { events.push({ type, data }) },
      },
    }
    ctx.tools.register(textTool('huge_read', 'H'.repeat(2_000)))
    const started = (n: number): boolean => events.some(event => event.type === 'tool/code-dispatch-start'
      && (event.data as { subCallId: string }).subCallId.endsWith(`:code:${n}`))
    const runPromise = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('parent-bound'),
      name: 'run_code',
      arguments: {
        code: 'await tools.huge_read({}); await tools.huge_read({}); await tools.huge_read({}); return "done"',
        description: 'Three oversized reads against a hung backend',
      },
      agent: agent as never,
    })
    // Two hung saves = backlog above the cap: the lane must hold before
    // starting dispatch 3.
    await vi.waitFor(() => {
      if (releases.length < 2) throw new Error('second hung save not reached yet')
    })
    expect(started(2)).toBe(true)
    expect(started(3)).toBe(false)
    releases.shift()!()
    // Draining one pending save releases the lane; dispatch 3 starts.
    await vi.waitFor(() => {
      if (!started(3)) throw new Error('third dispatch not started yet')
    })
    while (releases.length > 0) releases.shift()!()
    const result = await runPromise
    expect(result.isError).toBe(false)
    await vi.waitFor(() => {
      if (releases.length > 0) { while (releases.length > 0) releases.shift()!() }
      if (events.filter(event => event.type === 'tool/code-dispatch').length !== 3) {
        throw new Error('settle events still pending')
      }
    })
  })

  it('a saveText failure keeps the complete content in the durable log (best-effort)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    await ctx.plugin(StubStore)
    await ctx.plugin(SpillPolicy, { maxInlineBytes: 100 })
    await ctx.plugin(WorkerThreadCodeRuntime, {})
    ;(ctx.spillStore as StubStore).fail = true
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const events: { type: string; data: unknown }[] = []
    const agent = {
      session: {
        header: { id: SessionId('dispatch-spill-fail'), cwd: '/workspace' },
        append: (type: string, data: unknown) => { events.push({ type, data }) },
      },
    }
    ctx.tools.register(textTool('huge_read', 'H'.repeat(2_000)))
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('parent-2'),
      name: 'run_code',
      arguments: { code: 'return (await tools.huge_read({}))[0].text.length', description: 'Fail the spill backend' },
      agent: agent as never,
    })
    expect(result.isError).toBe(false)
    const settle = events.find(event => event.type === 'tool/code-dispatch')
    expect((settle!.data as { content: { text: string }[] }).content[0]!.text).toBe('H'.repeat(2_000))
    expect(warn).toHaveBeenCalled()
  })
})

describe('nested-call skip', () => {
  it('leaves nested composite results complete and spillable only through their outer call', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 10 })
    const body = 'x'.repeat(1000)
    ctx.tools.register(textTool('nested', body))
    const nested = {
      ...exec('nested'),
      parent: Symbol('outer') as ToolExecutionToken,
    }
    const result = await ctx.tools.execute(nested)
    expect(textOf(result.content)).toBe(body)
    expect(spill?.saves).toHaveLength(0)
  })
})

describe('best-effort fallback', () => {
  it('keeps the original result when saveText fails', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 10 })
    spill!.fail = true
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(result.isError).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('keeps the original result when no spill backend is loaded', async () => {
    const { ctx } = await setup({ maxInlineBytes: 10 }, false)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(warn).toHaveBeenCalled()
  })

  it('keeps the original result when the call has no session owner', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 10 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c'), name: 'big', arguments: {} })
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(spill?.saves).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
  })
})

describe('composition', () => {
  it('wraps an earlier tool-owned projection before applying the generic cap', async () => {
    let downstreamDecision: PostToolDecision | undefined
    const { ctx, spill } = await setup({ maxInlineBytes: 200 }, true, (target) => {
      target.on('tools/post-execute', async (_exec, _result, next): Promise<PostToolDecision> => {
        downstreamDecision = await next()
        return {
          kind: 'accept',
          content: [{ type: 'text', text: `first page\n\nFull canonical result stored at /spill/search-results.txt.\n${'z'.repeat(500)}` }],
        }
      })
    })
    ctx.tools.register(textTool('search', 'initial capped page'))

    const result = await ctx.tools.execute(exec('search'))

    expect(downstreamDecision).toEqual({ kind: 'accept' })
    expect(spill?.saves[0]?.content).toContain('Full canonical result stored at /spill/search-results.txt.')
    expect(textOf(result.content)).toContain('Full formatted result stored at')
  })

  it('bounds content a downstream post-execute listener replaced', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 200 })
    // A later-registered listener replaces the (small) tool result with a big one;
    // the policy delegated via next(), so it bounds the replacement.
    ctx.on('tools/post-execute', async (_e, _r, _next) =>
      ({ kind: 'accept', content: [{ type: 'text', text: 'z'.repeat(500) }] }))
    ctx.tools.register(textTool('small', 'tiny'))
    const result = await ctx.tools.execute(exec('small'))
    expect(spill?.saves[0]?.content).toBe('z'.repeat(500))
    expect(textOf(result.content)).toContain('Full formatted result stored at')
  })

  it('preserves downstream accept-decision contexts when spilling', async () => {
    const { ctx } = await setup({ maxInlineBytes: 200 })
    const context = createUserMessage({
      content: [{ type: 'text' as const, text: 'note' }],
      source: { kind: 'plugin' as const, plugin: 'test' },
    })
    ctx.on('tools/post-execute', async (_e, _r, _next) =>
      ({ kind: 'accept', additionalContexts: [context] }))
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toContain('Full formatted result stored at')
    expect(result.additionalContexts).toEqual([context])
  })

  it('passes a downstream value replacement through for registry rendering', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 10 })
    const replacement = [{ type: 'text' as const, text: 'z'.repeat(500) }]
    ctx.on('tools/post-execute', async () => ({ kind: 'accept' as const, value: replacement }))
    ctx.tools.register(textTool('small', 'tiny'))

    const result = await ctx.tools.execute(exec('small'))

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected replacement success')
    expect(result.value).toEqual(replacement)
    expect(textOf(result.content)).toBe('z'.repeat(500))
    expect(spill?.saves).toHaveLength(0)
  })
})

describe('cap invariant', () => {
  it('keeps the inline result when the notice alone exceeds the cap, even for a large original', async () => {
    // A large body (so it is well over the cap) but a cap smaller than the
    // notice itself: there is no within-cap replacement, so the policy must keep
    // the inline result rather than emit content over maxInlineBytes.
    const { ctx } = await setup({ maxInlineBytes: 8 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const body = 'x'.repeat(5000)
    ctx.tools.register(textTool('big', body))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe(body)
    expect(warn).toHaveBeenCalled()
  })
})

describe('disposal (HMR safety)', () => {
  it('stops transforming oversized results after the plugin fiber is disposed', async () => {
    const { ctx, spill, fiber } = await setup({ maxInlineBytes: 200 })
    const body = 'HEAD'.repeat(200) + 'TAIL'.repeat(200)
    ctx.tools.register(textTool('big', body))

    // Live: the listener spills and replaces.
    const before = await ctx.tools.execute(exec('big'))
    expect(textOf(before.content)).toContain('Full formatted result stored at')
    expect(spill?.saves).toHaveLength(1)

    // After disposal the listener is gone — the result passes through untouched
    // and nothing more is spilled (no leaked registration across reload).
    await fiber.dispose()
    const after = await ctx.tools.execute(exec('big'))
    expect(textOf(after.content)).toBe(body)
    expect(spill?.saves).toHaveLength(1)
  })
})
