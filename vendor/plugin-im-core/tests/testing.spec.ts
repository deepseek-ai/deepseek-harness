/**
 * Testkit: `FakeAdapter`, `runConformance`, `expectGolden` and the shared corpus.
 *
 * `runConformance` passes for a `FakeAdapter` mode and fails with a clear message when a handler drops text. The
 * earlier blocks verify the fake platform's own contract (recording, missing hooks ⇒ capability `none`, scripted
 * failures, stream drivers); the corpus block checks the shared corpus.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { h, normalize, type Tag, tags, toText, variantTable } from '@deepseek-ai/satori-element'
import {
  createRenderReport, ElementRegistry, type Mode, PlatformError, type Satori, Status, StreamLimitError,
} from '@deepseek-ai/cordis-plugin-im-core'
import {
  containsText, corpusCases, corpusInput, corpusKeys, createPlainMode, createTextMode,
  elementsText, expectGolden, expectedDegradations, FakeAdapter, type FakeAdapterConfig, goldenFile,
  goldenUpdateRequested, minimalContent, minimalParents, mountFakeAdapter, payloadText, renderCorpus, runConformance,
  streamingScripts,
} from '../src/testing.ts'

// ---- fixtures -----------------------------------------------------------------------------------------------------

const target = { chat: { id: 'fake:test', type: 'group' as const } }

const mounted: { dispose(): Promise<void> }[] = []

afterEach(async () => {
  for (const item of mounted.splice(0)) await item.dispose()
})

async function mount(config: Partial<FakeAdapterConfig> = {}) {
  const text = createTextMode()
  const result = await mountFakeAdapter({ modes: { text }, ...config })
  mounted.push({ dispose: () => result.ctx.fiber.dispose() })
  return result
}

const handleOf = (bot: FakeAdapter, part: import('@deepseek-ai/cordis-plugin-im-core').SentPart) => ({
  bot: bot.id, target, mode: 'text', parts: [part], createdAt: 0, edits: 0, content: normalize(h('p', 'x')),
})

const tickContext = (mode = 'text') => ({
  target,
  mode,
  options: {},
  signal: new AbortController().signal,
  report: createRenderReport(),
  content: normalize(h('p', 'streamed')),
  attempt: 1,
})

const prepared = (text: string) => ({ draft: text, resolved: new Map() }) as never

/** A text mode of the given element registry (the minimal-mode shape many tests need). */
function modeOf(id: string, elements: ElementRegistry<any, any>): Mode<any> {
  return {
    id,
    elements,
    limits: {},
    assemble: (nodes: string[]) => [nodes.join('')],
    serialize: (msg: { draft: string }) => ({ mode: id, text: msg.draft }),
  }
}

function baseRegistry() {
  return new ElementRegistry<any>()
    .register('text', (el: any) => el.attrs.content)
    .register('p', (el: any, ctx: any) => ctx.render(el.children).join(''))
    .register('br', () => '\n')
}


// ---- FakeAdapter --------------------------------------------------------------------------------------------------

describe('FakeAdapter', () => {
  it('mounts as a working bot with its own identity and modes', async () => {
    const { bot } = await mount()
    expect(bot.id).toBe('fake:bot')
    expect(bot.platform).toBe('fake')
    expect(bot.adapterName).toBe('fake')
    expect(bot.modes.text!.id).toBe('text')
    expect(bot.modeOrder).toEqual(['text'])
    expect(bot.status).toBe(Status.ONLINE)
  })

  it('declares its modes in the configured order, which breaks the resolution tie', async () => {
    const text = createTextMode()
    const rich = createTextMode({ id: 'rich' })
    const { bot } = await mount({ modes: { text, rich }, modeOrder: ['rich', 'text'] })
    expect(bot.modeOrder).toEqual(['rich', 'text'])
    expect((await bot.send(target, h('p', 'hi'))).handle.mode).toBe('rich')
  })

  it('records every send with the payload and the SendContext chain', async () => {
    const { bot } = await mount()
    await bot.sendPayload({ n: 1 }, target, { index: 0, options: {}, previous: [] })
    const first = bot.last('send')!
    const part = await bot.sendPayload({ n: 2 }, target, {
      index: 1, quote: 'quote-1', options: {}, previous: [first.part!],
    })
    expect(bot.sentPayloads()).toEqual([{ n: 1 }, { n: 2 }])
    expect(first.index).toBe(0)
    expect(first.quote).toBeUndefined()
    const second = bot.last('send')!
    expect(second.index).toBe(1)
    expect(second.quote).toBe('quote-1')
    expect(second.previous).toHaveLength(1)
    expect(second.part).toBe(part)
    expect(first.part!.id).not.toBe(part.id)
    expect(part.time).toBeTypeOf('number')
  })

  it('installs editPayload and deletePart only when the config allows them', async () => {
    const withHooks = await mount()
    expect(typeof withHooks.bot.editPayload).toBe('function')
    expect(typeof withHooks.bot.deletePart).toBe('function')

    const bare = await mount({ edit: false, delete: false })
    expect(bare.bot.editPayload).toBeUndefined()
    expect(bare.bot.deletePart).toBeUndefined()
  })

  it('records edits and deletes against the handle', async () => {
    const { bot } = await mount()
    const part = await bot.sendPayload({ n: 1 }, target, { index: 0, options: {}, previous: [] })
    const handle = handleOf(bot, part)
    await bot.editPayload!(part, { n: 2 }, handle)
    await bot.deletePart!(part, handle)
    expect(bot.calls('edit').map(operation => operation.payload)).toEqual([{ n: 2 }])
    expect(bot.calls('delete')).toHaveLength(1)
    expect(bot.calls('delete')[0]!.part).toBe(part)
  })

  it('scripts failures per operation, classified through classify()', async () => {
    const { bot } = await mount()
    bot.failNext('send', new Error('boom'))
    await expect(bot.sendPayload({ n: 1 }, target, { index: 0, options: {}, previous: [] }))
      .rejects.toMatchObject({ name: 'PlatformError', kind: 'retryable', message: 'boom' })
    // the failed operation is recorded with its error, the next one succeeds
    expect(bot.calls('send')).toHaveLength(1)
    expect(bot.calls('send')[0]!.error).toBeInstanceOf(Error)
    expect(bot.sentPayloads()).toEqual([])
    await bot.sendPayload({ n: 2 }, target, { index: 0, options: {}, previous: [] })
    expect(bot.sentPayloads()).toEqual([{ n: 2 }])

    // a PlatformError passes through unchanged, `times` repeats, `when` selects the operation
    const limit = new PlatformError('limit', 'too big', { published: 'no' })
    bot.failNext('send', limit, { times: 2 })
    await expect(bot.sendPayload({}, target, { index: 0, options: {}, previous: [] })).rejects.toBe(limit)
    await expect(bot.sendPayload({}, target, { index: 0, options: {}, previous: [] })).rejects.toBe(limit)
    await bot.sendPayload({}, target, { index: 0, options: {}, previous: [] })

    bot.failNext('send', new PlatformError('invalid', 'part 2'), { when: operation => operation.index === 1 })
    await bot.sendPayload({ part: 1 }, target, { index: 0, options: {}, previous: [] })
    await expect(bot.sendPayload({ part: 2 }, target, { index: 1, options: {}, previous: [] }))
      .rejects.toMatchObject({ kind: 'invalid' })

    bot.reset()
    expect(bot.operations).toEqual([])
  })

  it('uploads to a deterministic key and can simulate a platform without upload', async () => {
    const { bot } = await mount()
    const ref = { kind: 'image' as const, src: 'https://example.com/a.png', meta: { name: 'a.png' } }
    const context = {
      target, signal: new AbortController().signal, fetch: async () => ({ data: new Uint8Array() }), cache: {} as never,
    }
    const first = await bot.upload(ref as never, 'fake:test', context)
    const second = await bot.upload(ref as never, 'fake:test', context)
    expect(first.key).toBe(second.key)
    expect(first.key).toMatch(/^fake:fake:test:image:[0-9a-f]{12}$/)
    // another scope is another upload (QQ `file_info` is not interchangeable)
    const other = await bot.upload(ref as never, 'fake:other', context)
    expect(other.key).not.toBe(first.key)
    expect(bot.calls('upload').map(operation => operation.scope)).toEqual(['fake:test', 'fake:test', 'fake:other'])

    const noUpload = await mount({ upload: false })
    await expect(noUpload.bot.upload(ref as never, 'scope', context))
      .rejects.toMatchObject({ kind: 'permission', published: 'no' })
  })

  it('scopes resources by chat by default', async () => {
    const { bot } = await mount()
    expect(bot.resourceScope(target, 'image')).toBe('fake:test')
    const scoped = await mount({ scope: 'app' })
    expect(scoped.bot.resourceScope(target, 'image')).toBe('app')
  })

  it('drives the real bot pipeline (send, edit, render) end to end', async () => {
    const { bot } = await mount()
    const sent = await bot.send(target, h('p', 'hello from the fake'))
    expect(bot.sentPayloads()).toEqual([{ mode: 'text', text: 'hello from the fake' }])
    expect(sent.handle.parts).toHaveLength(1)
    expect(sent.report.degraded).toEqual([])

    const edited = await bot.edit(sent.handle, h('p', 'hello again'))
    expect(bot.calls('edit').map(operation => operation.payload))
      .toEqual([{ mode: 'text', text: 'hello again' }])
    expect(edited.handle.edits).toBe(1)

    // `render` is the dry run of the same pipeline: same payloads, no platform call
    const rendered = await bot.render(target, h('p', 'dry run'))
    expect(rendered.payloads).toEqual([{ mode: 'text', text: 'dry run' }])
    expect(bot.calls('send')).toHaveLength(1)
  })
})

describe('FakeAdapter stream drivers', () => {
  it('offers a driver only for the modes named in config.stream', async () => {
    const { bot } = await mount({ stream: { text: 'edit' }, streamLimit: 5 })
    expect(bot.streamDriver('text', target)!.strategy).toBe('edit')
    expect(bot.streamDriver('other', target)).toBeUndefined()
    expect(bot.streamDriver('text', target)?.strategy).toBe('edit')
  })

  it('opens, ticks and closes a whole-message stream, counting edits against the budget', async () => {
    const { bot } = await mount({ stream: { text: 'patch' }, streamLimit: 3 })
    const driver = bot.streamDriver('text', target)!
    expect(driver.strategy).toBe('patch')
    const ctx = tickContext()
    const handle = await driver.open(prepared('one'), { mode: 'text', text: 'one' }, ctx)
    expect(handle.parts).toHaveLength(1)
    expect(bot.sentPayloads()).toEqual([{ mode: 'text', text: 'one' }])

    await driver.tick(handle, { draft: prepared('one two'), payload: { mode: 'text', text: 'one two' } }, ctx)
    await driver.close(handle, { draft: prepared('one two three'), payload: { mode: 'text', text: 'one two three' } }, ctx)
    expect(bot.calls('edit').map(operation => operation.payload)).toEqual([
      { mode: 'text', text: 'one two' },
      { mode: 'text', text: 'one two three' },
    ])
    expect(bot.calls('stream.open')).toHaveLength(1)
    expect(bot.calls('stream.tick')).toHaveLength(1)
    expect(bot.calls('stream.close')).toHaveLength(1)
    expect(handle.edits).toBe(2)
    expect(driver.budget(handle)).toEqual({ updatesLeft: 1 })
  })

  it('skips a close that would repeat the published payload', async () => {
    const { bot } = await mount({ stream: { text: 'edit' } })
    const driver = bot.streamDriver('text', target)!
    const ctx = tickContext()
    const handle = await driver.open(prepared('same'), { mode: 'text', text: 'same' }, ctx)
    await driver.close(handle, { draft: prepared('same'), payload: { mode: 'text', text: 'same' } }, ctx)
    expect(bot.calls('edit')).toEqual([])
  })

  it('appends only prefix extensions and rejects anything else with StreamLimitError', async () => {
    const { bot } = await mount({ stream: { text: 'append' }, streamLimit: 10 })
    const driver = bot.streamDriver('text', target)!
    expect(driver.strategy).toBe('append')
    const ctx = tickContext()
    const handle = await driver.open(prepared('a'), { mode: 'text', text: 'a' }, ctx)
    await driver.tick(handle, { draft: prepared('ab'), payload: { mode: 'text', text: 'ab' } }, ctx)
    expect(bot.calls('edit').map(operation => operation.payload)).toEqual([{ append: 'b' }])
    await expect(driver.tick(handle, { draft: prepared('ax'), payload: { mode: 'text', text: 'ax' } }, ctx))
      .rejects.toBeInstanceOf(StreamLimitError)
    // a prefix extension after the failure still appends
    await driver.close(handle, { draft: prepared('abc'), payload: { mode: 'text', text: 'abc' } }, ctx)
    expect(bot.calls('edit').map(operation => operation.payload)).toEqual([{ append: 'b' }, { append: 'c' }])
    expect(driver.budget(handle)).toEqual({ updatesLeft: 8 })
  })

  it('records stream failures per stage', async () => {
    const { bot } = await mount({ stream: { text: 'edit' } })
    const driver = bot.streamDriver('text', target)!
    bot.failNext('stream.open', new PlatformError('rate-limit', 'slow down', { retryAfterMs: 1000 }))
    await expect(driver.open(prepared('a'), { text: 'a' }, tickContext())).rejects.toMatchObject({ kind: 'rate-limit' })
    expect(bot.calls('stream.open')[0]!.error).toBeInstanceOf(PlatformError)
  })
})

// ---- shared corpus --------------------------------------------------------------------------------------------------

describe('shared corpus', () => {
  it('covers every vocabulary element and every variant', () => {
    const keys = new Set(corpusKeys())
    const missing = [
      ...tags.filter(tag => !keys.has(`element.${tag}`)).map(tag => `element.${tag}`),
      ...Object.entries(variantTable).flatMap(([tag, variants]) =>
        variants.filter(variant => !keys.has(`element.${tag}.${variant}`)).map(variant => `element.${tag}.${variant}`)),
    ]
    expect(missing).toEqual([])
  })

  it('normalizes every case and every streaming state', () => {
    for (const item of corpusCases()) {
      const root = normalize(item.content)
      expect(root.type).toBe('message')
      expect(toText(root).length).toBeGreaterThan(0)
    }
    for (const script of streamingScripts()) {
      expect(script.states.length).toBeGreaterThan(1)
      for (const state of script.states) expect(normalize(state).type).toBe('message')
      const last = script.states[script.states.length - 1]!
      expect(toText(normalize(last)).length).toBeGreaterThan(0)
    }
    expect(new Set(corpusCases().map(item => item.name)).size).toBe(corpusCases().length)
    expect(new Set(streamingScripts().map(script => script.name)).size).toBe(streamingScripts().length)
  })

  it('has a minimal tree for every tag and knows the containers', () => {
    for (const tag of tags) {
      if (tag === 'message' || tag === 'quote' || tag === 'markdown') {
        expect(() => minimalContent(tag)).toThrow(/never rendered/)
        continue
      }
      expect(() => normalize(minimalContent(tag))).not.toThrow()
      for (const variant of variantTable[tag as keyof typeof variantTable] ?? []) {
        expect(() => normalize(minimalContent(tag, variant))).not.toThrow()
      }
    }
    expect(minimalParents('li')).toEqual(['ul'])
    expect(minimalParents('td')).toEqual(['table', 'tr'])
    expect(minimalParents('summary')).toEqual(['details'])
    expect(minimalParents('p')).toEqual([])
  })

  it('lowers the whole vocabulary through the core fallback table in a text-only mode', () => {
    const mode = createTextMode()
    const everything = corpusInput(corpusCases().find(item => item.name === 'everything')!.content)
    expect(elementsText(everything).length).toBeGreaterThan(20)
    const expected = expectedDegradations(everything, mode)
    expect(expected.map(item => item.tag)).toContain('table')
    expect(expected.map(item => item.tag)).toContain('at')
    // a lowered container replaces its children, so they are never reported (and must not be expected)
    expect(expected.map(item => item.tag)).not.toContain('tr')
    // an unregistered tag is lowered as a whole: the expectation carries no variant
    expect(expected.every(item => item.variant === undefined)).toBe(true)

    // a registered tag with an undeclared variant is lowered for that variant only
    const registry = baseRegistry().register('span', (el: any, ctx: any) => ctx.render(el.children).join(''))
    const spanMode = modeOf('spans', registry as ElementRegistry<any, any>)
    const expectedSpan = expectedDegradations(corpusInput(h('p', h('span', { color: 'danger' }, 'x'))), spanMode)
    expect(expectedSpan).toEqual([{ tag: 'span', variant: 'color' }])
  })
})

// ---- runConformance -------------------------------------------------------------------------------------------------

describe('runConformance', () => {
  it('passes for a FakeAdapter text mode', async () => {
    const { bot } = await mount()
    const result = await runConformance(bot, 'text')
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('text')
    expect(result.skipped).toEqual([])
    // three native cases (text, p, br) plus the shared corpus
    expect(result.cases).toBe(3 + corpusCases().length)
  })

  it('passes for a mode registering the whole vocabulary, and skips the envelope tags', async () => {
    const { bot } = await mount({ modes: { plain: createPlainMode(tags) } })
    const result = await runConformance(bot, 'plain')
    expect(result.problems).toEqual([])
    expect(result.cases).toBeGreaterThan(30)
    expect(result.skipped.map(item => item.case)).toContain('native:quote')
    expect(result.skipped.filter(item => item.reason.includes('declares no variant'))).toEqual([])
    // `<fallback>` and its cases are the engine's, so no registry tree can exercise them
    expect(result.skipped.map(item => item.case)).toEqual(expect.arrayContaining(['native:fallback', 'native:case']))
  })

  it('fails with a clear message when a handler drops text', async () => {
    const registry = new ElementRegistry<any>()
      .register('text', () => '')
      .register('p', (el: any, ctx: any) => ctx.render(el.children).join(''))
      .register('br', () => '\n')
    const { bot } = await mount({ modes: { lossy: modeOf('lossy', registry) } })
    const result = await runConformance(bot, 'lossy')
    expect(result.ok).toBe(false)
    expect(result.problems[0]!.case).toBe('native:text')
    expect(result.problems[0]!.message).toBe('text lost: "minimal text"')
    // the title of the `everything` case renders first, then the body
    expect(result.problems.find(problem => problem.case === 'corpus:everything')!.message)
      .toBe('text lost: "Everything at once"')
  })

  it('skips a native case whose container degrades instead of pretending it passed', async () => {
    const registry = baseRegistry().register(
      'td', (el: any, ctx: any) => ctx.render(el.children).join(''), { variants: ['block'] },
    ) as ElementRegistry<any, any>
    const { bot } = await mount({ modes: { tables: modeOf('tables', registry) } })
    const result = await runConformance(bot, 'tables')
    expect(result.problems).toEqual([])
    expect(result.skipped.find(item => item.case === 'native:td.block')?.reason)
      .toContain('container <table> degraded')
  })

  it('honours options.skip', async () => {
    const { bot } = await mount()
    const result = await runConformance(bot, 'text', { skip: ['everything'] })
    expect(result.skipped.map(item => item.case)).toContain('corpus:everything')
    expect(result.cases).toBe(3 + corpusCases().length - 1)
    expect(result.problems).toEqual([])
  })

  it('rejects an unknown mode with the available modes in the message', async () => {
    const { bot } = await mount()
    await expect(runConformance(bot, 'nope')).rejects.toThrow(/has no mode "nope" \(modes: text\)/)
    await expect(renderCorpus(bot, 'nope')).rejects.toThrow(/has no mode "nope"/)
  })

  it('renders the corpus for goldens, with one payload set per case', async () => {
    const { bot } = await mount()
    const renderings = await renderCorpus(bot, 'text')
    expect(renderings.map(item => item.name)).toEqual(corpusCases().map(item => item.name))
    const everything = renderings.find(item => item.name === 'everything')!
    expect(everything.payloads).toHaveLength(1)
    expect(payloadText(everything.payloads)).toContain('inline-code')
    expect(everything.report.degraded.length).toBeGreaterThan(0)
    // an ad-hoc case joins the shared corpus
    const extra = await renderCorpus(bot, 'text', { cases: [{ name: 'extra', content: h('p', 'extra text') }] })
    expect(extra[extra.length - 1]!.name).toBe('extra')
    // escaping-insensitive comparison: `payloadText` drops the adapter's backslash escapes
    expect(containsText(payloadText({ text: 'a \\*bold\\* b' }), '*bold*')).toBe(true)
    expect(containsText(payloadText({ text: 'a\nb' }), 'a b')).toBe(true)
    expect(containsText(payloadText({ text: 'a b' }), 'c')).toBe(false)
  })
})

// ---- expectGolden ---------------------------------------------------------------------------------------------------

describe('expectGolden', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
    delete process.env.IM_GOLDENS
  })

  function directory() {
    const dir = mkdtempSync(join(tmpdir(), 'im-goldens-'))
    directories.push(dir)
    return dir
  }

  it('writes the golden with IM_GOLDENS=update and compares it afterwards', () => {
    const dir = directory()
    const payloads = [{ mode: 'text', text: 'hello' }, { mode: 'text', text: 'world' }]
    expect(goldenUpdateRequested({ IM_GOLDENS: 'update' })).toBe(true)
    expect(goldenUpdateRequested({ IM_GOLDENS: 'nope' })).toBe(false)
    expect(goldenFile('case', { dir })).toBe(join(dir, 'case.json'))

    process.env.IM_GOLDENS = 'update'
    expectGolden('case', payloads, { dir })
    const written = readFileSync(join(dir, 'case.json'), 'utf8')
    expect(written).toContain('"text": "hello"')
    expect(written.endsWith(']\n')).toBe(true)

    delete process.env.IM_GOLDENS
    expect(() => expectGolden('case', payloads, { dir })).not.toThrow()
    // the file round-trips, so a class instance or an undefined field cannot cause a false diff
    expect(() => expectGolden('case', JSON.parse(written), { dir })).not.toThrow()
  })

  it('fails on a missing golden with an instruction, and on a difference with a diff', () => {
    const dir = directory()
    expect(() => expectGolden('missing', [], { dir })).toThrow(/does not exist yet.*IM_GOLDENS=update/)

    writeFileSync(join(dir, 'case.json'), '[\n  {\n    "text": "old"\n  }\n]\n')
    expect(() => expectGolden('case', [{ text: 'new' }], { dir }))
      .toThrow(/differs from[\s\S]*line 3[\s\S]*"text": "old"[\s\S]*"text": "new"/)
  })

  it('records the payloads of a corpus rendering', async () => {
    const dir = directory()
    const { bot } = await mount()
    const renderings = await renderCorpus(bot, 'text')
    process.env.IM_GOLDENS = 'update'
    expectGolden('text', renderings, { dir })
    delete process.env.IM_GOLDENS
    expect(() => expectGolden('text', renderings, { dir })).not.toThrow()
  })
})

// ---- helpers --------------------------------------------------------------------------------------------------------

describe('testkit helpers', () => {
  it('describes the corpus for reports', () => {
    for (const item of corpusCases()) expect(item.title.length).toBeGreaterThan(3)
    for (const script of streamingScripts()) expect(script.title.length).toBeGreaterThan(3)
    expect(corpusCases().find(item => item.name === 'everything')!.title)
      .toBe('every element of the vocabulary in one message')
    const tag: Tag = 'table'
    expect(toText(normalize(minimalContent(tag, 'align')))).toContain('Header')
  })

  const runtimeUrl = new URL('../lib/index.js', import.meta.url)
  const testingUrl = new URL('../lib/testing.js', import.meta.url)

  it.skipIf(!existsSync(runtimeUrl) || !existsSync(testingUrl))(
    'shares PlatformError class identity across built runtime and testing entrypoints',
    async () => {
      const runtime = await import(runtimeUrl.href) as { PlatformError: typeof PlatformError; Satori: typeof Satori }
      const testing = await import(testingUrl.href) as { FakeAdapter: typeof FakeAdapter }
      const { Context } = await import('@deepseek-ai/cordis')
      const ctx = new Context()
      await ctx.plugin(runtime.Satori)
      const err = new runtime.PlatformError('permission', 'denied', { published: 'no' })
      const adapter = new testing.FakeAdapter(ctx, { modes: {} })
      expect(adapter.classify(err)).toBe(err)
      expect(adapter.classify(err)).toBeInstanceOf(runtime.PlatformError)
      await ctx.fiber.dispose()
    },
  )
})
