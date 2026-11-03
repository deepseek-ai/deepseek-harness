/**
 * The `markdown` service inside the render engine: expansion in place, the core fallback without the service, and the
 * settled-block rendering of an `append` stream's intermediate states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h, type Target } from '@deepseek-ai/cordis-plugin-im-core'
import { createTextMode, type FakeAdapterConfig, mountFakeAdapter } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import Markdown from '@deepseek-ai/cordis-plugin-im-markdown'

const target: Target = { chat: { id: 'c1', type: 'direct' } }
/** Text of a payload of the test text mode (paragraphs are joined without a separator). */
const text = (payload: unknown) => (payload as { text: string } | undefined)?.text
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const dispose of disposers.splice(0)) await dispose()
})

async function mount(config: Partial<FakeAdapterConfig> = {}, markdown = true) {
  const mounted = await mountFakeAdapter({ modes: { text: createTextMode() }, ...config })
  disposers.push(() => mounted.ctx.fiber.dispose())
  const plugin = markdown ? await mounted.ctx.plugin(Markdown) : undefined
  return { ...mounted, plugin }
}

describe('markdown service', () => {
  it('expands <markdown> while the message renders, in the place of the element', async () => {
    const { bot } = await mount()
    const result = await bot.render(target, h('message', h('p', 'before'), h.markdown('**b** c\n\nd')))
    expect(result.payloads.map(text)).toEqual(['beforeb cd'])
    expect(result.report.degraded.filter(entry => entry.tag === 'markdown')).toEqual([])
  })

  it('takes the paragraph content of a one-paragraph document inside phrasing content', async () => {
    const { bot } = await mount()
    const result = await bot.render(target, h('p', 'say: ', h.markdown('**hi**')))
    expect(result.payloads.map(text)).toEqual(['say: hi'])
  })

  it('publishes the source as literal text without the service, and again once the service is gone', async () => {
    const { bot } = await mount({}, false)
    const result = await bot.render(target, h.markdown('**b**'))
    expect(result.payloads.map(text)).toEqual(['**b**'])
    expect(result.report.degraded).toMatchObject([{ tag: 'markdown' }])

    const { bot: other, plugin } = await mount()
    expect((await other.render(target, h.markdown('**b**'))).payloads.map(text)).toEqual(['b'])
    await plugin!.dispose()
    expect((await other.render(target, h.markdown('**b**'))).payloads.map(text)).toEqual(['**b**'])
  })

  it('streams only the settled blocks of the trailing markdown into an append stream', async () => {
    vi.useFakeTimers()
    const { bot } = await mount({ stream: { text: 'append' } })
    const stream = bot.stream(target)
    // Nothing is settled while the only block is still being written.
    stream.update(h.markdown('**un'))
    await vi.advanceTimersByTimeAsync(400)
    expect(bot.operations.filter(op => op.op.startsWith('stream'))).toEqual([])
    stream.update(h.markdown('one **a**\n\ntwo **un'))
    await vi.advanceTimersByTimeAsync(400)
    stream.update(h.markdown('one **a**\n\ntwo **unclosed** end'))
    await vi.advanceTimersByTimeAsync(400)
    const done = stream.close(h.markdown('one **a**\n\ntwo **unclosed** end'))
    await vi.advanceTimersByTimeAsync(3000)
    await done

    const ops = bot.operations.filter(op => op.op.startsWith('stream.'))
    expect(ops.map(op => [op.op, text(op.payload)])).toEqual([
      ['stream.open', 'one a'],
      ['stream.close', 'one atwo unclosed end'],
    ])
  })

  it('renders every intermediate state whole for a stream that can rewrite what it shows', async () => {
    vi.useFakeTimers()
    const { bot } = await mount({ stream: { text: 'edit' } })
    const stream = bot.stream(target)
    stream.update(h.markdown('one\n\ntwo **un'))
    await vi.advanceTimersByTimeAsync(1000)
    const done = stream.close(h.markdown('one\n\ntwo **unclosed**'))
    await vi.advanceTimersByTimeAsync(3000)
    await done
    expect(bot.operations.filter(op => op.op !== 'upload').map(op => text(op.payload))[0]).toBe('onetwo **un')
  })

  it('renders a markdown that something follows whole, because it no longer grows', async () => {
    vi.useFakeTimers()
    const { bot } = await mount({ stream: { text: 'append' } })
    const stream = bot.stream(target)
    stream.update(h('message', h.markdown('one\n\ntwo'), h('p', 'footer')))
    await vi.advanceTimersByTimeAsync(400)
    expect(text(bot.operations.find(op => op.op === 'stream.open')?.payload)).toBe('onetwofooter')
    await stream.abort()
  })
})
