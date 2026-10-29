/** QQ `text` mode : conformance, goldens, media split, linkPolicy and the passive parts budget. */
import { describe, expect, it } from 'vitest'
import { h } from '@deepseek-ai/satori-element'
import { expectGolden, renderCorpus, runConformance } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import { direct, goldens, group, mountQQ } from './mount.ts'

describe('QQ text mode', () => {
  it('passes conformance', async () => {
    const bot = await mountQQ()
    const result = await runConformance(bot, 'text', { target: group })
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('matches the corpus golden', async () => {
    const bot = await mountQQ()
    const rendered = await renderCorpus(bot, 'text', { target: group })
    expectGolden('text', rendered.map(item => ({ name: item.name, payloads: item.payloads })), { dir: goldens })
  })

  it('splits media into msg_type 7 messages between text runs', async () => {
    const bot = await mountQQ()
    const { payloads, report } = await bot.render(group, [
      h('p', 'before'),
      h('img', { src: 'https://example.com/a.png' }),
      h('p', 'after'),
    ])
    expect(payloads).toEqual([
      { msg_type: 0, content: 'before' },
      { msg_type: 7, content: ' ', media: { file_info: expect.stringMatching(/^dryrun:image:/) } },
      { msg_type: 0, content: 'after' },
    ])
    expect(report.split).toBe(2)
  })

  it('writes only link labels by default and keeps URLs with linkPolicy keep', async () => {
    const content = h('p', 'see ', h('a', { href: 'https://example.com/x' }, 'docs'))
    const plain = await mountQQ()
    expect((await plain.render(group, content)).payloads).toEqual([{ msg_type: 0, content: 'see docs' }])
    const keep = await mountQQ({ linkPolicy: 'keep' })
    expect((await keep.render(group, content)).payloads).toEqual([{ msg_type: 0, content: 'see docs (https://example.com/x)' }])
  })

  it('clamps parts to the passive budget by merging text and folding trailing media', async () => {
    const bot = await mountQQ({ passive: { groupWindowMs: 300_000, c2cWindowMs: 3_600_000, groupReplies: 2, c2cReplies: 2, seqBase: 2 } })
    const { payloads, report } = await bot.render(direct, [
      'one',
      h('img', { src: 'https://example.com/1.png', alt: 'cat' }),
      'two',
      h('img', { src: 'https://example.com/2.png' }),
    ])
    expect(payloads).toEqual([
      { msg_type: 0, content: 'one\ntwo\n[图片]' },
      { msg_type: 7, content: ' ', media: { file_info: expect.any(String) } },
    ])
    expect(report.degraded).toContainEqual(expect.objectContaining({ tag: 'img', via: 'qq-parts-limit' }))
  })

  it('declares the 2-minute recall window and no update', async () => {
    const bot = await mountQQ()
    expect(bot.modes.text.limits['limit.delete.window']).toBe(120_000)
    expect(bot.modes.text.limits['limit.update.count']).toBeUndefined()
  })

  it('diffs prefix extensions as appends', () => {
    return mountQQ().then(bot => {
      const diff = bot.modes.text.diff!
      expect(diff({ msg_type: 0, content: 'ab' }, { msg_type: 0, content: 'abc' })).toEqual([{ append: 'c' }])
      expect(diff({ msg_type: 0, content: 'ab' }, { msg_type: 0, content: 'ab' })).toEqual([])
      expect(diff({ msg_type: 0, content: 'ab' }, { msg_type: 0, content: 'xb' })).toBe('replace')
    })
  })
})
