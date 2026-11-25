/** QQ custom keyboards: hoisting, 5 × 5 grid, labels, button mapping and the config-dependent element table. */
import { describe, expect, it } from 'vitest'
import { h } from '@deepseek-ai/satori-element'
import { expectGolden, renderCorpus, runConformance } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import { goldens, group, mountQQ } from './mount.ts'

const onClick = () => {}

describe('QQ keyboard', () => {
  it('passes conformance in the markdown mode with keyboard', async () => {
    const bot = await mountQQ({ markdown: true, keyboard: true })
    const result = await runConformance(bot, 'markdown', { target: group })
    expect(result.problems).toEqual([])
  })

  it('matches the corpus golden', async () => {
    const bot = await mountQQ({ markdown: true, keyboard: true })
    const rendered = await renderCorpus(bot, 'markdown', { target: group })
    expectGolden('markdown-keyboard', rendered.map(item => ({ name: item.name, payloads: item.payloads })), { dir: goldens })
  })

  it('declares buttons only with markdown and keyboard', async () => {
    expect((await mountQQ({ keyboard: true })).modes.markdown.elements.has('element.button')).toBe(false)
    expect((await mountQQ({ markdown: true })).modes.markdown.elements.has('element.button')).toBe(false)
    const both = await mountQQ({ markdown: true, keyboard: true })
    expect(both.modes.markdown.elements.has('element.button')).toBe(true)
    expect(both.modes.markdown.elements.has('element.button.inline')).toBe(true)
    expect(both.modes.markdown.elements.has('element.button.action')).toBe(true)
    expect(both.modes.markdown.limits).toMatchObject({ 'limit.buttons.row': 5, 'limit.buttons.rows': 5 })
  })

  it('hoists buttons into keyboard rows with the platform action encoding', async () => {
    const bot = await mountQQ({ markdown: true, keyboard: true })
    const { payloads, report } = await bot.render(group, [
      h('p', 'pick one'),
      h('button-group',
        h('button', { type: 'action', id: 'stop', data: 'now', theme: 'danger', onClick }, 'Stop'),
        h('button', { type: 'link', href: 'https://example.com' }, 'Open'),
        h('button', { type: 'input', text: '/status', send: true, theme: 'info' }, 'Status')),
      h('button', { type: 'action', id: 'long', onClick }, 'A very long label here'),
    ])
    expect(payloads).toHaveLength(1)
    const [payload] = payloads as any[]
    expect(payload.markdown).toEqual({ content: 'pick one' })
    expect(payload.keyboard.content.rows).toEqual([
      {
        buttons: [
          {
            id: 'stop',
            render_data: { label: 'Stop', visited_label: 'Stop', style: 3 },
            action: { type: 1, permission: { type: 2 }, data: 'stop:now', unsupport_tips: expect.stringContaining('Stop') },
          },
          {
            render_data: { label: 'Open', visited_label: 'Open', style: 0 },
            action: { type: 0, permission: { type: 2 }, data: 'https://example.com', unsupport_tips: expect.any(String) },
          },
          {
            render_data: { label: 'Status', visited_label: 'Status', style: 1 },
            action: { type: 2, permission: { type: 2 }, data: '/status', enter: true, unsupport_tips: expect.any(String) },
          },
        ],
      },
      {
        buttons: [{
          id: 'long',
          render_data: { label: 'A very lo…', visited_label: 'A very lo…', style: 0 },
          action: { type: 1, permission: { type: 2 }, data: 'long', unsupport_tips: expect.stringContaining('A very long label here') },
        }],
      },
    ])
    // Regression (live 40011000 请求数据异常): a row is a `{"buttons": […]}` object, never a bare button array.
    for (const row of payload.keyboard.content.rows) {
      expect(Array.isArray(row)).toBe(false)
      expect(Array.isArray(row.buttons)).toBe(true)
    }
    expect(report.moved).toContainEqual(expect.objectContaining({ tag: 'button', reason: 'qq-label-truncated' }))
  })

  it('wraps rows at 5 and drops buttons beyond 5 rows into text', async () => {
    const bot = await mountQQ({ markdown: true, keyboard: true })
    const buttons = Array.from({ length: 27 }, (_, i) => h('button', { type: 'action', id: `b${i}`, onClick }, `B${i}`))
    const { payloads, report } = await bot.render(group, [h('p', 'grid'), h('button-group', ...buttons)])
    const [payload] = payloads as any[]
    expect(payload.keyboard.content.rows.map((row: { buttons: unknown[] }) => row.buttons.length)).toEqual([5, 5, 5, 5, 5])
    expect(payload.markdown.content).toBe('grid\n\n[B25] [B26]')
    expect(report.dropped.map(item => item.what)).toEqual(['button:b25', 'button:b26'])
  })

  it('creates a carrier message for a keyboard without text and keeps disabled buttons as text', async () => {
    const bot = await mountQQ({ markdown: true, keyboard: true })
    const only = await bot.render(group, h('button', { type: 'input', text: '/help' }, 'Help'))
    expect((only.payloads as any[])[0].markdown).toEqual({ content: '\u200B' })
    const disabled = await bot.render(group, h('button', { type: 'action', id: 'x', disabled: true, onClick }, 'Off'))
    expect(disabled.payloads).toEqual([{ msg_type: 2, markdown: { content: '[Off]' } }])
    expect(disabled.report.dropped).toContainEqual({ what: 'button:x', reason: 'qq-button-disabled' })
  })

  it('reports a keyboard grid violation in check()', async () => {
    const bot = await mountQQ({ markdown: true, keyboard: true })
    const rows = Array.from({ length: 6 }, () => ({ buttons: [{}] }))
    expect(bot.modes.markdown.check!({ msg_type: 2, content: 'x', keyboard: { content: { rows } } }))
      .toContainEqual(expect.objectContaining({ key: 'limit.buttons.rows', actual: 6 }))
  })
})
