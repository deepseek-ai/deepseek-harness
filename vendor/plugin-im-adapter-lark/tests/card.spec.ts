/**
 * Lark card mode.
 *
 * Covers:
 * - `createCardMode()` passes `runConformance` on a `FakeAdapter`.
 * - Corpus payloads are compared against `tests/goldens/card/*.json` (rewrite with `IM_GOLDENS=update`).
 * - Folding: 300 panels stay ≤ 200 elements and report `folded`, without losing text.
 * Plus the card-markdown escaper and the button/mention vetoes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'
import { type Fragment, h } from '@deepseek-ai/satori-element'
import {
  expectGolden, mountFakeAdapter, payloadText, renderContent, renderCorpus, runConformance,
} from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import {
  CARD_ELEMENT_LIMIT, cardRequestBody, countCardElements, createCardMode, type CardDraft, type CardJson,
  type CardModeConfig, type CardPayload,
} from '../src/modes/card.ts'
import {
  cardCodeSpan, cardElementId, cardFence, escapeCardText, normalizeCardMarkdown, prefixLines, textMarkdown,
} from '../src/modes/card-markdown.ts'

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

const goldenDir = 'vendor/plugin-im-adapter-lark/tests/goldens/card'
const mounted: { dispose(): Promise<void> }[] = []

afterEach(async () => {
  for (const item of mounted.splice(0)) await item.dispose()
})

async function mount(config: CardModeConfig = {}) {
  const mode = createCardMode(config)
  const result = await mountFakeAdapter({ modes: { card: mode } })
  await result.ctx.plugin(Markdown)
  mounted.push({ dispose: () => result.ctx.fiber.dispose() })
  return { ...result, mode }
}

/** normalize → transform → prepare → serialize through the fake adapter (offline). */
async function render(content: Fragment, config: CardModeConfig = {}) {
  const { bot, mode } = await mount(config)
  const target = { chat: { id: 'lark:test', type: 'group' as const } }
  return renderContent(bot, content, { target, mode })
}

function card(payload: unknown): CardJson {
  const value = payload as CardPayload
  expect(value.msg_type).toBe('interactive')
  return value.content as CardJson
}

function elements(payload: unknown): Record<string, any>[] {
  return card(payload).body.elements as Record<string, any>[]
}

// ---------------------------------------------------------------------------------------------------------------
// Conformance and goldens

describe('card mode: conformance', () => {
  it('passes runConformance with callbacks and @all allowed', async () => {
    const { bot } = await mount()
    const result = await runConformance(bot, 'card')
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('passes runConformance with @all forbidden and without streaming', async () => {
    const { bot } = await mount({ allowAtAll: false, cardStreaming: false })
    const result = await runConformance(bot, 'card')
    expect(result.problems).toEqual([])
  })

  it('without callbacks the corpus still conserves text and reports every fallback', async () => {
    const { bot } = await mount({ callbacks: false })
    const result = await runConformance(bot, 'card')
    // The per-key minimal trees of `button.theme` / `button.inline` / `button-group` use action buttons,
    // which this configuration does not declare; everything else (and the whole corpus) must be clean.
    expect(result.problems.filter(problem => !/^native:button/.test(problem.case))).toEqual([])
  })

  it('matches the corpus goldens', async () => {
    const { bot } = await mount()
    for (const item of await renderCorpus(bot, 'card')) {
      expectGolden(item.name, { payloads: item.payloads, report: JSON.parse(JSON.stringify(item.report)) }, { dir: goldenDir })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Card markdown

describe('card markdown escaping', () => {
  it('escapes the markdown syntax of literal text', () => {
    expect(escapeCardText('2 * 3 = _x_ ~y~ `z` [a](b) # h | c > d \\')).toBe(
      '2 \\* 3 = \\_x\\_ \\~y\\~ \\`z\\` \\[a]\\(b) # h | c > d \\\\')
  })

  it('gives < and an entity-looking & the entity the platform documents', () => {
    expect(escapeCardText('/home/agent/.dsh/skills/<name>/SKILL.md')).toBe(
      '/home/agent/.dsh/skills/&#60;name>/SKILL.md')
    expect(escapeCardText('<at id=all></at> <font color=red>x</font> a<b')).toBe(
      '&#60;at id=all>&#60;/at> &#60;font color=red>x&#60;/font> a&#60;b')
    expect(escapeCardText('a & b &amp; &#60; &x')).toBe('a & b &#38;amp; &#38;#60; &#38;x')
  })

  it('leaves a < that cannot open a tag literal', () => {
    expect(escapeCardText('2 < 3')).toBe('2 < 3')
    expect(escapeCardText('Array<string> is not a tag either')).toBe('Array&#60;string> is not a tag either')
  })

  it('keeps the spaces of one run, including the trailing one', () => {
    expect(escapeCardText('run  now ')).toBe('run  now ')
    expect(textMarkdown('run  now')).toBe('run  now')
  })

  it('neutralises block markers at line starts', () => {
    expect(escapeCardText('- item\n1. first\n+ plus\n===\na - b\n3.5\n= 104 B, align 8')).toBe(
      '\\- item\n1\\. first\n\\+ plus\n\\===\na - b\n3.5\n\\= 104 B, align 8')
  })

  it('unwraps bare URLs into explicit links and keeps newlines as <br>', () => {
    expect(textMarkdown('see https://example.com/a_b. done\nnext')).toBe(
      'see [https\\://example.com/a\\_b](https://example.com/a_b). done<br>next')
    expect(textMarkdown('https://example.com', false)).toBe('https\\://example.com')
  })

  it('keeps code verbatim, because the platform decodes no entity inside code', () => {
    expect(cardCodeSpan('a<b `c`')).toBe('`` a<b `c` ``')
    expect(cardCodeSpan('``x``')).toBe('` ``x`` `')
    expect(cardCodeSpan('a\r\nb')).toBe('`a b`')
    expect(cardCodeSpan('')).toBe('')
    expect(cardFence('```\n<at id=all>', 'ts')).toBe('````ts\n```\n<at id=all>\n````')
    expect(cardFence('a\n<b>\n')).toBe('```\na\n<b>\n```')
    expect(cardFence('body', 'ts space')).toBe('```tsspace\nbody\n```')
  })

  it('never indents fences when prefixing list continuation lines', () => {
    expect(prefixLines('para\n```\ncode\n```\nafter', '- ', '    ')).toBe('- para\n```\ncode\n```\n    after')
    expect(prefixLines('a\n\nb', '> ', '> ')).toBe('> a\n>\n> b')
  })

  it('ports normalizeMarkdown: dedent and close fences, unwrap autolinks, leave < alone', () => {
    expect(normalizeCardMarkdown('  ```ts\n<x>\n')).toBe('```ts\n<x>\n\n```')
    expect(normalizeCardMarkdown('<https://a.b/c> <b>x</b> <at id=1></at><br>')).toBe(
      '[https://a.b/c](https://a.b/c) <b>x</b> <at id=1></at><br>')
    expect(normalizeCardMarkdown('````\n```\n````\n<i>')).toBe('````\n```\n````\n<i>')
    expect(normalizeCardMarkdown('')).toBe('')
  })

  it('leaves a < inside an inline code span alone through the normalize pass', () => {
    expect(normalizeCardMarkdown('run `cat <name> | x` now')).toBe('run `cat <name> | x` now')
    expect(normalizeCardMarkdown('run ``a`<name>`` now')).toBe('run ``a`<name>`` now')
    expect(normalizeCardMarkdown('`` `x` and <at id=all> ``')).toBe('`` `x` and <at id=all> ``')
  })

  it('element ids: e + 15 base32 chars, deterministic', () => {
    const id = cardElementId('message/p[0]')
    expect(id).toMatch(/^e[a-z2-7]{15}$/)
    expect(cardElementId('message/p[0]')).toBe(id)
    expect(cardElementId('message/p[1]')).not.toBe(id)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Structure

describe('card structure', () => {
  it('merges consecutive text blocks into one markdown component and keeps hr/img as components', async () => {
    const { payloads } = await render([
      h('p', 'one'), h('h2', 'two'), h('ul', h('li', 'three')), h('hr'), h('p', 'four'),
      h('img', { src: 'https://example.com/x.png', alt: 'x' }),
    ])
    const list = elements(payloads[0])
    expect(list.map(item => item.tag)).toEqual(['markdown', 'hr', 'markdown', 'img'])
    expect(list[0]!.content).toBe('one\n\n## two\n\n- three')
    expect(list[3]!.img_key).toBe('fake:lark:test:image:' + list[3]!.img_key.split(':').pop())
    expect(list[3]!.alt).toEqual({ tag: 'plain_text', content: 'x' })
    expect(card(payloads[0]).config).toEqual({ update_multi: true })
  })

  it('splits markdown components at four tables', async () => {
    const table = () => h('table', h('tr', h('th', 'h')), h('tr', h('td', 'c')))
    const { payloads } = await render([table(), table(), table(), table(), table()])
    const list = elements(payloads[0])
    expect(list).toHaveLength(2)
    expect(list[0]!.content.match(/\| --- \|/g)).toHaveLength(4)
  })

  it('renders nested lists, task items and fences inside list items', async () => {
    const { payloads } = await render(h('ol', { start: 2 },
      h('li', { checked: true }, h('p', 'done'), h('ul', h('li', 'child'))),
      h('li', h('pre', { lang: 'sh' }, 'ls'))))
    expect(elements(payloads[0])[0]!.content).toBe('2. [x] done\n    - child\n3.\n```sh\nls\n```')
  })

  it('renders details as nested collapsible panels with the summary as markdown title', async () => {
    const { payloads } = await render(h('details', { open: true }, h('summary', h('b', 'outer')),
      h('p', 'body'), h('details', h('summary', 'inner'), h('p', 'deep'))))
    const [panel] = elements(payloads[0])
    expect(panel!.tag).toBe('collapsible_panel')
    expect(panel!.expanded).toBe(true)
    expect(panel!.header.title).toEqual({ tag: 'markdown', content: '**outer**' })
    expect(panel!.elements.map((item: any) => item.tag)).toEqual(['markdown', 'collapsible_panel'])
    expect(panel!.elements[1].header.title.content).toBe('inner')
  })

  it('small → notation markdown; span color → font; at → <at id>', async () => {
    const { payloads } = await render([
      h('p', h('span', { color: 'danger' }, 'red'), ' ', h('at', { type: 'user', id: 'ou_1', name: 'A' }), h('at', { type: 'all' })),
      h('small', 'fine'),
    ])
    const [text, small] = elements(payloads[0])
    expect(text!.content).toBe("<font color='red'>red</font> <at id=ou_1></at><at id=all></at>")
    expect(small).toMatchObject({ tag: 'markdown', content: 'fine', text_size: 'notation' })
  })

  it('title → header with template from theme', async () => {
    const { payloads } = await render([h('title', { subtitle: 'sub', theme: 'success' }, 'Head **x**'), h('p', 'body')])
    expect(card(payloads[0]).header).toEqual({
      title: { tag: 'plain_text', content: 'Head **x**' },
      subtitle: { tag: 'plain_text', content: 'sub' },
      template: 'green',
    })
  })

  it('buttons carry v4 callback values, open_url links and column_set groups; inline buttons are hoisted', async () => {
    const onClick = () => {}
    const { payloads, report, transform: result } = await render([
      h('button-group',
        h('button', { type: 'action', id: 'stop', data: 'x', onClick, theme: 'danger' }, 'Stop'),
        h('button', { type: 'link', href: 'https://example.com' }, 'Open')),
      h('p', 'run ', h('button', { type: 'action', id: 'go', onClick }, 'Go'), ' now'),
    ])
    const [group, text, hoisted] = elements(payloads[0])
    expect(group!.tag).toBe('column_set')
    expect(group!.columns[0].elements[0]).toMatchObject({
      tag: 'button', type: 'danger_filled', text: { tag: 'plain_text', content: 'Stop' },
      behaviors: [{ type: 'callback', value: { v4: { id: 'stop', data: 'x' } } }],
    })
    expect(group!.columns[1].elements[0].behaviors).toEqual([{ type: 'open_url', default_url: 'https://example.com' }])
    expect(text!.content).toBe('run  now')
    expect(hoisted).toMatchObject({ tag: 'button', behaviors: [{ type: 'callback', value: { v4: { id: 'go' } } }] })
    expect(report.moved).toEqual([expect.objectContaining({ tag: 'button', reason: 'hoisted' })])
    expect(result.actions.map(action => action.id)).toEqual(['stop', 'go'])
  })

  it('input buttons fall back to their label and text: a card cannot send a message', async () => {
    const { payloads, report } = await render(
      h('p', 'run ', h('button', { type: 'input', text: '/status' }, 'Status'), ' now'))
    const rendered = elements(payloads[0])
    expect(rendered.some(element => element.tag === 'button')).toBe(false)
    expect(rendered[0]!.content).toContain('Status')
    expect(rendered[0]!.content).toContain('/status')
    expect(report.degraded).toEqual([expect.objectContaining({ tag: 'button', variant: 'input' })])
  })

  it('without callbacks, action buttons fall back to text and the action variant is undeclared', async () => {
    const { bot, mode } = await mount({ callbacks: false })
    expect(mode.elements.has('element.button.action')).toBe(false)
    expect(mode.elements.has('element.button.link')).toBe(true)
    const target = { chat: { id: 'lark:test', type: 'group' as const } }
    const rendered = await renderContent(bot, h('button', { type: 'action', id: 'b' }, 'Go'), { target, mode })
    expect(rendered.report.degraded).toEqual([expect.objectContaining({ tag: 'button', variant: 'action' })])
    expect(elements(rendered.payloads[0])[0]!.content).toBe('\\[Go]')
  })

  it('allowAtAll: false renders @all as text', async () => {
    const { payloads, report } = await render(h('p', h('at', { type: 'all' }), ' hi'), { allowAtAll: false })
    expect(elements(payloads[0])[0]!.content).toBe('@所有人 hi')
    expect(report.degraded).toEqual([expect.objectContaining({ tag: 'at', variant: 'all' })])
  })

  it('media split into their own messages; non-opus audio becomes a file', async () => {
    const { payloads, report } = await render([
      h('p', 'before'), h('audio', { src: 'https://example.com/a.mp3', name: 'a.mp3' }), h('p', 'after'),
    ])
    expect(payloads.map(payload => (payload as CardPayload).msg_type)).toEqual(['interactive', 'file', 'interactive'])
    expect(report.split).toBe(2)
    expect(report.moved).toEqual([expect.objectContaining({ tag: 'audio', reason: 'not-opus' })])
  })

  it('declares the title envelope, action buttons and the limits from config', async () => {
    const { mode } = await mount()
    expect(mode.elements.inEnvelope('title')).toBe(true)
    expect(mode.elements.has('element.button.action')).toBe(true)
    // `limit.stream.interval` keeps two edits of the same message 200 ms apart (the platform allows 5 QPS per message).
    expect(mode.limits).toEqual({ 'limit.elements': 200, 'limit.payload.bytes': 30_000, 'limit.stream.interval': 200 })
    expect(createCardMode({ cardStreaming: false }).limits['limit.stream.interval']).toBeUndefined()
  })

  it('cardRequestBody encodes content', async () => {
    const { payloads } = await render(h('p', 'x'))
    const payload = payloads[0] as CardPayload
    expect(JSON.parse(cardRequestBody(payload).content)).toEqual(payload.content)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Budget and size

describe('element budget', () => {
  const panels = (count: number) => Array.from({ length: count }, (_, index) =>
    h('details', h('summary', `step ${index}`), h('p', `detail of step ${index}`)))

  it('folds the oldest of 300 panels so the card stays within 200 elements, keeping all text', async () => {
    const { payloads, report, drafts } = await render(panels(300))
    const json = card(payloads[0])
    expect(countCardElements(json)).toBeLessThanOrEqual(CARD_ELEMENT_LIMIT)
    expect(report.folded).toBeGreaterThan(0)
    const list = json.body.elements as Record<string, any>[]
    expect(list[0]!.tag).toBe('markdown')
    expect(list[list.length - 1]!.tag).toBe('collapsible_panel')
    expect(list[list.length - 1]!.header.title.content).toBe('step 299')
    const text = payloadText(payloads)
    for (let index = 0; index < 300; index++) {
      expect(text).toContain(`step ${index}`)
      expect(text).toContain(`detail of step ${index}`)
    }
    expect(createCardMode().check!(drafts[0] as CardDraft)).toEqual([])
    expect(report.summary('en')).toContain(`${report.folded} panels folded`)
  })

  it('does not fold when the card fits', async () => {
    const { report } = await render(panels(10))
    expect(report.folded).toBe(0)
  })

  it('check() reports cards above 30 KB', async () => {
    const { drafts } = await render(h('p', 'x'.repeat(31_000)))
    expect(createCardMode().check!(drafts[0] as CardDraft)).toEqual([
      expect.objectContaining({ kind: 'size', key: 'limit.payload.bytes', limit: 30_000 }),
    ])
  })
})
