/**
 * Lark card mode.
 *
 * Covers:
 * - `createCardMode()` passes `runConformance` on a `FakeAdapter`.
 * - Corpus payloads are compared against `tests/goldens/card/*.json` (rewrite with `IM_GOLDENS=update`).
 * - Folding: 300 panels stay ≤ 200 elements and report `folded`, without losing text.
 * - Diff: prefix extension → `content` op; changed panel → `patch`; reorder → `replace`; ids stable across
 *   re-transforms when keys are set.
 * Plus the card-markdown escaper and the button/mention vetoes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Fragment, h, normalize } from '@deepseek-ai/satori-element'
import { type Prepared, ResourceRef, transform } from '@deepseek-ai/cordis-plugin-im-core'
import {
  expectGolden, mountFakeAdapter, payloadText, renderContent, renderCorpus, runConformance,
} from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import {
  CARD_ELEMENT_LIMIT, cardKitOps, cardRequestBody, countCardElements, createCardMode, type CardDraft, type CardJson,
  type CardMessageDraft, type CardModeConfig, type CardPatch, type CardPayload, streamingCard,
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
  mounted.push({ dispose: () => result.ctx.fiber.dispose() })
  return { ...result, mode }
}

/** normalize → transform → prepare → serialize through the fake adapter (offline). */
async function render(content: Fragment, config: CardModeConfig = {}) {
  const { bot, mode } = await mount(config)
  const target = { chat: { id: 'lark:test', type: 'group' as const } }
  return renderContent(bot, content, { target, mode })
}

/** The drafts of one content tree (for diff tests). */
async function drafter(config: CardModeConfig = {}) {
  const { bot, mode } = await mount(config)
  const target = { chat: { id: 'lark:test', type: 'group' as const } }
  return {
    mode,
    draft: (content: Fragment) => transform(normalize(content), { bot, target, mode }).msgs[0] as CardMessageDraft,
  }
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
  it('escapes model-markdown metacharacters of literal text', () => {
    expect(escapeCardText('2 * 3 = _x_ ~y~ `z` [a](b) # h | c > d \\')).toBe(
      '2 \\* 3 = \\_x\\_ \\~y\\~ \\`z\\` \\[a\\](b) \\# h \\| c \\> d \\\\')
  })

  it('turns every < into an entity, so text can never open an allowed tag', () => {
    expect(escapeCardText('<at id=all></at> <font color=red>x</font> a<b')).toBe(
      '&#60;at id=all\\>&#60;/at\\> &#60;font color=red\\>x&#60;/font\\> a&#60;b')
  })

  it('escapes entity-looking ampersands only', () => {
    expect(escapeCardText('a & b &amp; &#60; &x')).toBe('a & b &#38;amp; &#38;\\#60; &x')
  })

  it('neutralises block markers at line starts', () => {
    expect(escapeCardText('- item\n1. first\n+ plus\n===\na - b\n3.5\n= 104 B, align 8')).toBe(
      '\\- item\n1\\. first\n\\+ plus\n\\===\na - b\n3.5\n= 104 B, align 8')
  })

  it('unwraps bare URLs into explicit links and keeps newlines as <br>', () => {
    expect(textMarkdown('see https://example.com/a_b. done\nnext')).toBe(
      'see [https://example.com/a\\_b](https://example.com/a_b). done<br>next')
    expect(textMarkdown('https://example.com', false)).toBe('https://example.com')
  })

  it('keeps code spans verbatim, because the platform decodes no entity inside code', () => {
    expect(cardCodeSpan('a<b `c`')).toBe('`` a<b `c` ``')
    expect(cardFence('```\n<at id=all>', 'ts')).toBe('````ts\n```\n<at id=all>\n````')
  })

  it('never indents fences when prefixing list continuation lines', () => {
    expect(prefixLines('para\n```\ncode\n```\nafter', '- ', '    ')).toBe('- para\n```\ncode\n```\n    after')
    expect(prefixLines('a\n\nb', '> ', '> ')).toBe('> a\n>\n> b')
  })

  it('ports normalizeMarkdown: dedent fences, close unterminated fences, unwrap autolinks, escape unknown tags', () => {
    expect(normalizeCardMarkdown('  ```ts\n<x>\n')).toBe('```ts\n<x>\n\n```')
    expect(normalizeCardMarkdown('<https://a.b/c> <b>x</b> <at id=1></at><br>')).toBe(
      '[https://a.b/c](https://a.b/c) &#60;b>x&#60;/b> <at id=1></at><br>')
    expect(normalizeCardMarkdown('````\n```\n````\n<i>')).toBe('````\n```\n````\n&#60;i>')
    expect(normalizeCardMarkdown('')).toBe('')
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
    expect(elements(rendered.payloads[0])[0]!.content).toBe('\\[Go\\]')
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
    expect(mode.limits).toEqual({ 'limit.elements': 200, 'limit.payload.bytes': 30_000, 'limit.stream.interval': 120 })
    expect(createCardMode({ cardStreaming: false }).limits['limit.stream.interval']).toBeUndefined()
  })

  it('cardRequestBody encodes content; streamingCard toggles CardKit streaming', async () => {
    const { payloads } = await render(h('p', 'x'))
    const payload = payloads[0] as CardPayload
    expect(JSON.parse(cardRequestBody(payload).content)).toEqual(payload.content)
    const on = streamingCard(card(payload), true)
    expect(on.config).toMatchObject({ update_multi: true, streaming_mode: true, streaming_config: { print_strategy: 'fast' } })
    expect(streamingCard(on, false).config.streaming_mode).toBe(false)
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

// ---------------------------------------------------------------------------------------------------------------
// Diff

describe('diff', () => {
  it('prefix extension of a text block → one content op with append', async () => {
    const { mode, draft } = await drafter()
    const prev = draft(h('p', 'Reading the workspace'))
    const next = draft(h('p', 'Reading the workspace and the tests'))
    const ops = mode.diff!(prev, next) as CardPatch[]
    expect(ops).toEqual([expect.objectContaining({ op: 'content', id: prev.elements[0]!.id, append: true })])
    expect(mode.diff!(next, next)).toEqual([])
    const rewrite = mode.diff!(next, draft(h('p', 'Build is green'))) as CardPatch[]
    expect(rewrite).toEqual([expect.objectContaining({ op: 'content', append: false })])
  })

  it('a new block after a component → insert anchored after it; a removed one → delete', async () => {
    const { mode, draft } = await drafter()
    const prev = draft([h('p', 'a'), h('hr')])
    const next = draft([h('p', 'a'), h('hr'), h('p', 'b')])
    const ops = mode.diff!(prev, next) as CardPatch[]
    expect(ops).toEqual([{ op: 'insert', components: [next.elements[2]], after: prev.elements[1]!.id }])
    expect(mode.diff!(next, prev)).toEqual([{ op: 'delete', id: next.elements[2]!.id }])
  })

  it('changed panel header → patch; changed panel child → content op on the child', async () => {
    const { mode, draft } = await drafter()
    const panel = (summary: string, body: string) => draft(h('details', h('summary', summary), h('p', body)))
    const ops = mode.diff!(panel('working', 'x'), panel('done', 'x')) as CardPatch[]
    expect(ops).toEqual([expect.objectContaining({ op: 'patch', fields: ['header', 'expanded'] })])
    const child = mode.diff!(panel('working', 'x'), panel('working', 'xy')) as CardPatch[]
    expect(child).toEqual([expect.objectContaining({ op: 'content', append: true })])
  })

  it('reordered keyed blocks → replace; header change → replace; media → replace', async () => {
    const { mode, draft } = await drafter()
    const a = h('details', { key: 'a' }, h('summary', 'A'), h('p', '1'))
    const b = h('details', { key: 'b' }, h('summary', 'B'), h('p', '2'))
    const prev = draft([a, b])
    const next = draft([
      h('details', { key: 'b' }, h('summary', 'B'), h('p', '2')),
      h('details', { key: 'a' }, h('summary', 'A'), h('p', '1')),
    ])
    expect(mode.diff!(prev, next)).toBe('replace')
    expect(mode.diff!(draft([h('title', 'x'), h('p', 'y')]), draft([h('title', 'z'), h('p', 'y')]))).toBe('replace')
    const media: CardDraft = { kind: 'media', msgType: 'file', ref: new ResourceRef('file', 'f') }
    expect(mode.diff!(media, prev)).toBe('replace')
  })

  it('ids are stable across re-transforms when keys are set, even with content inserted above', async () => {
    const { mode, draft } = await drafter()
    const tail = () => h('details', { key: 'tail' }, h('summary', 'Tail'), h('p', 'end'))
    const prev = draft([h('p', 'x'), h('hr'), tail()])
    const next = draft([h('p', 'x'), h('hr'), h('p', 'new'), h('hr'), tail()])
    expect(next.elements[4]!.id).toBe(prev.elements[2]!.id)
    expect(draft([h('p', 'x'), h('hr'), tail()]).elements.map(item => item.id)).toEqual(prev.elements.map(item => item.id))
    const ops = mode.diff!(prev, next) as CardPatch[]
    expect(ops.map(op => op.op)).toEqual(['insert'])
  })

  it('too many ops → replace', async () => {
    const { mode, draft } = await drafter({ maxPatchOps: 2 })
    const sep = (text: string) => Array.from({ length: 3 }, (_, i) => [h('p', `p${i}${text}`), h('hr')]).flat()
    expect(mode.diff!(draft(sep('')), draft(sep('!')))).toBe('replace')
  })

  it('cardKitOps resolves image placeholders and picks patch fields', async () => {
    const { mode, draft } = await drafter()
    const prev = draft(h('p', 'a'))
    const next = draft([h('p', 'a ', h('img', { src: 'https://example.com/i.png', alt: 'i' })), h('button', { type: 'link', href: 'https://x.y' }, 'Go')])
    const ops = mode.diff!(prev, next) as CardPatch[]
    const ref = (next.elements[0] as any).refs[0] as ResourceRef
    const prepared: Prepared<CardDraft> = { draft: next, resolved: new Map([[ref, { key: 'img_v2_1' }]]) }
    expect(cardKitOps(ops, prepared)).toEqual([
      expect.objectContaining({ type: 'insert', after: prev.elements[0]!.id }),
      { type: 'content', elementId: prev.elements[0]!.id, content: 'a ![i](img_v2_1)', append: true },
    ])
    const relabel = mode.diff!(next, draft([h('p', 'a ', h('img', { src: 'https://example.com/i.png', alt: 'i' })), h('button', { type: 'link', href: 'https://x.y' }, 'Gone')])) as CardPatch[]
    expect(cardKitOps(relabel, prepared)).toEqual([
      { type: 'patch', elementId: next.elements[1]!.id, partial: { text: { tag: 'plain_text', content: 'Gone' } } },
    ])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Through the core stream scheduler

describe('streaming through the core scheduler', () => {
  it('a patch driver receives the diff ops of each tick', async () => {
    const result = await mountFakeAdapter({ modes: { card: createCardMode() }, stream: { card: 'patch' } })
    mounted.push({ dispose: () => result.ctx.fiber.dispose() })
    const { bot } = result
    const stream = bot.stream({ chat: { id: 'lark:test', type: 'group' } }, { firstDelayMs: 0, intervalMs: 0 })
    expect(stream.strategy).toBe('patch')
    stream.update(h('p', 'Reading the workspace'))
    await vi.waitFor(() => expect(bot.calls('stream.open')).toHaveLength(1))
    stream.update(h('p', 'Reading the workspace and the tests'))
    await vi.waitFor(() => expect(bot.calls('stream.tick')).toHaveLength(1), { timeout: 3000 })
    expect(bot.calls('stream.tick')[0]!.patches).toEqual([expect.objectContaining({ op: 'content', append: true })])
    await stream.close(h('p', 'Reading the workspace and the tests. Done.'))
    expect(bot.calls('stream.close')).toHaveLength(1)
  })
})