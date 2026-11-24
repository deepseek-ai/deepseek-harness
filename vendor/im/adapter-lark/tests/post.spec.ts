/**
 * Lark post mode.
 *
 * Covers:
 * - `createPostMode()` passes `runConformance` on a `FakeAdapter` (registered tags render natively, the shared corpus
 *   conserves its text, the report lists every degradation).
 * - The corpus payloads are compared against `tests/goldens/post/*.json` (rewrite with `IM_GOLDENS=update`).
 * - The escaping / structure blocks pin the properties a payload golden cannot explain: post-md escaping of model
 *   markdown edge cases, the image "own paragraph" rule, media splitting, title/subtitle, mention syntax, the 30 KB
 *   check and the element table.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as Markdown from '@deepseek-ai/cordis-plugin-im-markdown'
import { h, type Fragment } from '@deepseek-ai/satori-element'
import type { Prepared, SerializeContext } from '@deepseek-ai/cordis-plugin-im-core'
import { expectGolden, mountFakeAdapter, renderCorpus, runConformance } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import {
  createPostMode, POST_PAYLOAD_BYTES, POST_UPDATE_LIMIT, postRequestBody, type PostDraft, type PostPayload,
  type PostTextDraft,
} from '../src/modes/post.ts'
import {
  codeSpan, escapeBlockStart, escapePostMd, fenceBlock, idempotencyUuid, mentionMarkdown, wrapInline,
} from '../src/modes/shared.ts'

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

const target = { chat: { id: 'lark:test', type: 'group' as const } }
const goldenDir = 'vendor/im/adapter-lark/tests/goldens/post'

const mounted: { dispose(): Promise<void> }[] = []

afterEach(async () => {
  for (const item of mounted.splice(0)) await item.dispose()
})

async function mount(options: { allowAtAll?: boolean; stream?: boolean } = {}) {
  const { allowAtAll } = options
  const mode = createPostMode(allowAtAll === undefined ? {} : { allowAtAll })
  const result = await mountFakeAdapter({
    modes: { post: mode },
    ...options.stream ? { stream: { post: 'edit' as const } } : {},
  })
  await result.ctx.plugin(Markdown)
  mounted.push({ dispose: () => result.ctx.fiber.dispose() })
  return { ...result, mode }
}

type PostNote = { tag: string; text?: string; image_key?: string }

interface PostBody {
  title?: string
  content: PostNote[][]
}

function bodyOf(payload: unknown): PostBody {
  const post = payload as PostPayload
  expect(post.msg_type).toBe('post')
  return post.content.zh_cn as PostBody
}

/** Every md text of a payload, one entry per paragraph row. */
function mdTexts(payload: unknown): string[] {
  return bodyOf(payload).content.map(row => row.map(node => node.text ?? '').join(''))
}

function mdText(payload: unknown): string {
  return mdTexts(payload).join('\n')
}

/** Tags of the nodes in one paragraph row, e.g. `['md']` or `['img']`. */
function rowTags(payload: unknown, index: number): string[] {
  return (bodyOf(payload).content[index] ?? []).map(node => node.tag)
}

async function render(content: Fragment) {
  const { bot } = await mount()
  return bot.render(target, content)
}

/** Render `content` and return its single payload (fails loudly when the mode split it). */
async function renderOne(content: Fragment) {
  const { payloads } = await render(content)
  expect(payloads).toHaveLength(1)
  return payloads[0]!
}

/** A draft of one md paragraph of plain text (the unit `check` and `serialize` are driven with). */
function draftOf(text: string): PostTextDraft {
  return { kind: 'post', paragraphs: [{ kind: 'md', lines: [{ prefix: '', inlines: [{ kind: 'raw', text }] }] }] }
}

const serializeContext = { target, mode: 'post', index: 0, count: 1, options: {} } as unknown as SerializeContext

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers

describe('post-md escaping', () => {
  it('escapes the markdown metacharacters of the dialect', () => {
    // `*`, `_`, `~`, the backtick, brackets, angle brackets, `#` and the table pipe.
    expect(escapePostMd("*a* _b_ ~c~ `d` [e] <f> #g |h|")).toBe(
      "\\*a\\* \\_b\\_ \\~c\\~ \\`d\\` \\[e\\] \\<f\\> \\#g \\|h\\|",
    )
  })

  it('escapes the backslash itself, so an escape cannot be escaped away', () => {
    expect(escapePostMd('C:\\temp')).toBe('C:\\\\temp')
    expect(escapePostMd('\\*')).toBe('\\\\\\*')
  })

  it('keeps CJK, emoji and ordinary punctuation untouched', () => {
    expect(escapePostMd('你好，世界 🚀 — plain.')).toBe('你好，世界 🚀 — plain.')
  })

  it('neutralises a block marker that would start a list, a rule or a heading underline', () => {
    expect(escapePostMd('- item')).toBe('\\- item')
    expect(escapePostMd('+ item')).toBe('\\+ item')
    expect(escapePostMd('1. item')).toBe('1\\. item')
    expect(escapePostMd('12) item')).toBe('12\\) item')
    expect(escapePostMd('---')).toBe('\\---')
    expect(escapePostMd('===')).toBe('\\===')
  })

  it('leaves inline look-alikes alone', () => {
    expect(escapePostMd('a - b')).toBe('a - b')
    expect(escapePostMd('1.5 apples')).toBe('1.5 apples')
    expect(escapePostMd('-foo')).toBe('-foo')
  })

  it('escapes per line, so a marker after a newline is caught too', () => {
    expect(escapePostMd('text\n- item')).toBe('text\n\\- item')
  })

  it('escapes only the marker of a line, not the rest of it', () => {
    expect(escapeBlockStart('  - nested')).toBe('  \\- nested')
    expect(escapeBlockStart('plain - text')).toBe('plain - text')
  })
})

describe('shared markdown builders', () => {
  it('writes the mention syntax of each dialect', () => {
    expect(mentionMarkdown('post', { type: 'user', id: 'ou_1', name: 'Alice' }))
      .toBe('<at user_id="ou_1">Alice</at>')
    expect(mentionMarkdown('card', { type: 'user', id: 'ou_1', name: 'Alice' })).toBe('<at id=ou_1>Alice</at>')
    expect(mentionMarkdown('post', { type: 'all' })).toBe('<at user_id="all"></at>')
    expect(mentionMarkdown('card', { type: 'all', name: 'everyone' })).toBe('<at id=all>everyone</at>')
    // A role has no syntax in either dialect: the label survives, the mention does not.
    expect(mentionMarkdown('post', { type: 'role', id: 'r_1', name: 'Admins' })).toBe('@Admins')
    expect(mentionMarkdown('post', { type: 'user' })).toBe('')
  })

  it('strips the characters that would break the mention tag', () => {
    expect(mentionMarkdown('post', { type: 'user', id: 'ou_1', name: '<A&B>' })).toBe('<at user_id="ou_1">AB</at>')
    expect(mentionMarkdown('post', { type: 'user', id: 'ou_1" x="y', name: 'Alice' }))
      .toBe('<at user_id="ou_1xy">Alice</at>')
    expect(mentionMarkdown('card', { type: 'user', id: 'ou_1><b>', name: 'Alice' })).toBe('<at id=ou_1b>Alice</at>')
    // Punctuation stripped down to `all` or `here` is recognized as @everyone and degrades to plain text.
    expect(mentionMarkdown('post', { type: 'user', id: 'all"', name: '所有人' })).toBe('@所有人')
    expect(mentionMarkdown('card', { type: 'user', id: 'here>', name: '在线' })).toBe('@在线')
    expect(mentionMarkdown('post', { type: 'user', id: '"><' })).toBe('')
  })

  it('writes an idempotency uuid that is stable per part and hex-32', () => {
    const first = idempotencyUuid('send:1')
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(idempotencyUuid('send:1')).toBe(first)
    expect(idempotencyUuid('send:1', 1)).not.toBe(first)
    expect(idempotencyUuid('send:2')).not.toBe(first)
  })

  it('builds code spans and fences whose delimiter the content cannot close', () => {
    expect(codeSpan('plain')).toBe('`plain`')
    expect(codeSpan('a`b')).toBe('``a`b``')
    expect(codeSpan('`edge')).toBe('`` `edge ``')
    expect(codeSpan('')).toBe('')
    expect(fenceBlock('const x = 1', 'ts')).toBe('```ts\nconst x = 1\n```')
    expect(fenceBlock('a\n```\nb')).toBe('````\na\n```\nb\n````')
    expect(fenceBlock('one\n')).toBe('```\none\n```')
  })

  it('hoists whitespace out of an inline marker pair', () => {
    expect(wrapInline('**', 'bold')).toBe('**bold**')
    expect(wrapInline('**', ' bold ')).toBe(' **bold** ')
    expect(wrapInline('**', '   ')).toBe('   ')
    expect(wrapInline('<u>', 'x', '</u>')).toBe('<u>x</u>')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Conformance and goldens

describe('post mode conformance', () => {
  it('renders every registered element natively and conserves the corpus text', async () => {
    const { bot } = await mount()
    const result = await runConformance(bot, 'post')
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.cases).toBeGreaterThan(30)
  })

  it('records a payload golden for every corpus case', async () => {
    const { bot } = await mount()
    const renderings = await renderCorpus(bot, 'post')
    expect(renderings.length).toBeGreaterThan(30)
    for (const rendering of renderings) {
      expectGolden(rendering.name, rendering.payloads, { dir: goldenDir })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Inline content

describe('post inline content', () => {
  it('writes the inline marks of the dialect', async () => {
    const payload = await renderOne(h('p', 'plain ', h('b', 'bold'), ' ', h('i', 'italic'), ' ',
      h('u', 'underline'), ' ', h('s', 'strike'), ' ', h('code', 'const x = 1')))
    expect(mdTexts(payload)).toEqual(['plain **bold** *italic* <u>underline</u> ~~strike~~ `const x = 1`'])
  })

  it('escapes user text inside a mark and keeps the markers working', async () => {
    const payload = await renderOne(h('p', h('b', 'a * b'), ' ', h('b', ' padded ')))
    expect(mdTexts(payload)).toEqual(['**a \\* b**  **padded** '])
  })

  it('writes a link and autolinks a bare url', async () => {
    const payload = await renderOne(h('p',
      h('a', { href: 'https://example.com/docs' }, 'the docs'), ' ', h('a', { href: 'https://example.com/x' })))
    expect(mdTexts(payload)).toEqual(['[the docs](https://example.com/docs) https://example.com/x'])
  })

  it('escapes a link destination that would close the parentheses early', async () => {
    const payload = await renderOne(h('p', h('a', { href: 'https://example.com/a b(c)' }, 'label')))
    expect(mdTexts(payload)).toEqual(['[label](https://example.com/a%20b%28c%29)'])
  })

  it('writes mentions with the post syntax', async () => {
    const payload = await renderOne(h('p',
      h('at', { type: 'user', id: 'ou_1', name: 'Alice' }), ' ', h('at', { type: 'all' })))
    expect(mdTexts(payload)).toEqual(['<at user_id="ou_1">Alice</at> <at user_id="all"></at>'])
  })

  it('degrades @all to text when the config forbids it', async () => {
    const { bot, mode } = await mount({ allowAtAll: false })
    const { payloads, report } = await bot.render(target, h('p', h('at', { type: 'all' }), ' build is green'))
    expect(mode.elements.has('element.at.all')).toBe(false)
    expect(mdTexts(payloads[0])).toEqual(['@所有人 build is green'])
    expect(report.degraded.map(entry => `${entry.tag}.${entry.variant}`)).toEqual(['at.all'])
  })

  it('never mentions everyone for a user whose id spells it', async () => {
    // Feishu reads `user_id="all"` as @everyone; a `user` mention carries no `all` variant for allowAtAll to withhold.
    const { bot } = await mount({ allowAtAll: false })
    const { payloads } = await bot.render(target, h('p', h('at', { type: 'user', id: 'all', name: '所有人' }), ' hi'))
    expect(mdTexts(payloads[0])).toEqual(['@所有人 hi'])
  })

  it('keeps a hard break inside one paragraph', async () => {
    const payload = await renderOne(h('p', 'first line', h('br'), 'second line'))
    expect(mdTexts(payload)).toEqual(['first line\\\nsecond line'])
  })

  it('strips the backslashes to the literal text of model markdown edge cases', async () => {
    const source = "a *b* _c_ <d> [e] #f |g| `h` ~i~"
    const payload = await renderOne(h('p', source))
    expect(mdText(payload).replace(/\\+/g, '')).toBe(source)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Block content

describe('post block content', () => {
  it('writes headings as md headings', async () => {
    const payload = await renderOne([h('h1', 'One'), h('h3', 'Three'), h('h6', 'Six')])
    expect(mdTexts(payload)).toEqual(['# One', '### Three', '###### Six'])
  })

  it('writes lists with markers, task boxes, a start offset and nesting', async () => {
    const payload = await renderOne([
      h('ul', h('li', 'first'), h('li', { checked: true }, 'done'), h('li', 'parent', h('ul', h('li', 'child')))),
      h('ol', { start: 3 }, h('li', 'third'), h('li', 'fourth')),
    ])
    expect(mdTexts(payload)).toEqual([
      '- first\n- [x] done\n- parent\n  - child',
      '3. third\n4. fourth',
    ])
  })

  it('writes a nested quote with one marker per level', async () => {
    const payload = await renderOne(h('blockquote', h('p', 'outer'), h('blockquote', h('p', 'inner'))))
    expect(mdTexts(payload)).toEqual(['> outer\n>\n> > inner'])
  })

  it('keeps the marker on every physical line of a hard break inside a quote', async () => {
    const payload = await renderOne(h('blockquote', h('p', 'one', h('br'), 'two')))
    expect(mdTexts(payload)).toEqual(['> one\\\n> two'])
  })

  it('writes a fenced code block with its language', async () => {
    const payload = await renderOne(h('pre', { lang: 'ts' }, 'const answer = 42\nconsole.log(answer)'))
    expect(mdTexts(payload)).toEqual(['```ts\nconst answer = 42\nconsole.log(answer)\n```'])
  })

  it('writes a table with its header, alignment and cell text', async () => {
    const payload = await renderOne(h('table',
      h('tr', h('th', 'Name'), h('th', { align: 'right' }, 'Qty')),
      h('tr', h('td', 'apple'), h('td', '3'))))
    expect(mdTexts(payload)).toEqual(['| Name | Qty |\n| --- | ---: |\n| apple | 3 |'])
  })

  it('flattens a block cell into one table line', async () => {
    const payload = await renderOne(h('table',
      h('tr', h('th', 'Details')),
      h('tr', h('td', h('p', 'paragraph one'), h('p', 'paragraph two')))))
    expect(mdText(payload)).toContain('| paragraph one paragraph two |')
  })

  it('renders a horizontal rule as the native node', async () => {
    const { payloads } = await render([h('p', 'above'), h('hr'), h('p', 'below')])
    expect(payloads).toHaveLength(1)
    expect(rowTags(payloads[0], 0)).toEqual(['md'])
    expect(rowTags(payloads[0], 1)).toEqual(['hr'])
    expect(rowTags(payloads[0], 2)).toEqual(['md'])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Media and envelope

describe('post media', () => {
  it('gives an image its own paragraph and reports the move', async () => {
    const { payloads, report } = await render(
      h('p', 'before ', h('img', { src: 'https://example.com/a.png', alt: 'shot' }), ' after'),
    )
    expect(payloads).toHaveLength(1)
    const body = bodyOf(payloads[0])
    expect(body.content).toHaveLength(3)
    expect(body.content[1]).toEqual([{ tag: 'img', image_key: 'dryrun:image:https://example.com/a.png' }])
    expect(mdTexts(payloads[0])).toEqual(['before ', '', ' after'])
    expect(report.moved).toEqual([{ tag: 'img', path: 'message/p[0]/img[1]', reason: 'own-paragraph' }])
  })

  it('publishes a block image as a native image paragraph', async () => {
    const { payloads } = await render(h('img', { src: 'https://example.com/b.png', alt: 'block' }))
    expect(rowTags(payloads[0], 0)).toEqual(['img'])
  })

  it('splits a message around its media elements', async () => {
    const { payloads, report } = await render([
      h('p', 'voice:'),
      h('audio', { src: 'https://example.com/media/voice.opus', name: 'voice.opus' }),
      h('file', { src: 'https://example.com/media/report.pdf', name: 'report.pdf' }),
      h('p', 'done'),
    ])
    expect(payloads.map(payload => (payload as PostPayload).msg_type)).toEqual(['post', 'audio', 'file', 'post'])
    expect(mdTexts(payloads[0])).toEqual(['voice:'])
    expect(mdTexts(payloads[3])).toEqual(['done'])
    expect(report.split).toBe(3)
  })

  it('publishes a non-opus audio and a non-mp4 video as a file and reports it', async () => {
    const { payloads, report } = await render([
      h('audio', { src: 'https://example.com/media/voice.mp3', name: 'voice.mp3' }),
      h('video', { src: 'https://example.com/media/clip.webm', name: 'clip.webm' }),
    ])
    expect(payloads.map(payload => (payload as PostPayload).msg_type)).toEqual(['file', 'file'])
    expect(report.moved.map(entry => entry.reason)).toEqual(['not-opus', 'not-mp4'])
  })

  it('resolves the uploaded key into the media payload', async () => {
    const { bot } = await mount()
    const { handle } = await bot.send(target, h('audio', {
      src: 'https://example.com/media/voice.opus', name: 'voice.opus',
    }))
    expect((bot.last('send')?.payload as PostPayload).content.file_key).toBeTruthy()
    expect(bot.calls('upload')).toHaveLength(1)
    expect(handle.parts).toHaveLength(1)
  })
})

describe('post envelope', () => {
  it('writes the title into the post body and the subtitle into the first paragraph', async () => {
    const { payloads, report } = await render([
      h('title', { subtitle: 'subtitle text' }, 'Release notes'),
      h('p', 'body of the titled message'),
    ])
    expect(bodyOf(payloads[0]).title).toBe('Release notes')
    expect(mdTexts(payloads[0])).toEqual(['*subtitle text*', 'body of the titled message'])
    expect(report.moved.map(entry => entry.reason)).toEqual(['subtitle-paragraph'])
  })

  it('answers the quoted message through the reply target, not through the body', async () => {
    const { bot } = await mount()
    await bot.send(target, [h('quote', { id: 'om_1' }), h('p', 'answer')])
    expect(bot.last('send')?.quote).toBe('om_1')
    expect(bodyOf(bot.last('send')?.payload).content).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Mode contract

describe('post mode table', () => {
  it('declares the post element table and limits', () => {
    const mode = createPostMode()
    expect(mode.id).toBe('post')
    // A root `<title>` becomes the post title through `assemble`, not through a registry handler.
    expect(mode.elements.inEnvelope('title')).toBe(true)
    expect(mode.limits).toEqual({
      'limit.payload.bytes': POST_PAYLOAD_BYTES,
      'limit.update.count': POST_UPDATE_LIMIT,
    })
  })

  it('exposes the registry entries and the driver an in-place edit needs', async () => {
    const { bot, mode } = await mount({ stream: true })
    expect(mode.elements.inEnvelope('title')).toBe(true)
    expect(mode.limits['limit.update.count']).toBe(POST_UPDATE_LIMIT)
    expect(mode.elements.has('element.pre.lang')).toBe(true)
    expect(mode.elements.has('element.li.checked')).toBe(true)
    expect(bot.streamDriver('post', target)?.strategy).toBe('edit')
  })

  it('flags a body above the 30 KB limit and accepts one inside it', () => {
    const mode = createPostMode()
    const violations = mode.check!(draftOf('x'.repeat(POST_PAYLOAD_BYTES)))
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ kind: 'size', key: 'limit.payload.bytes', limit: POST_PAYLOAD_BYTES })
    expect(violations[0]!.actual!).toBeGreaterThan(POST_PAYLOAD_BYTES)
    expect(mode.check!(draftOf('short'))).toEqual([])
  })

  it('honours a configured locale, payload budget and edit budget', () => {
    const mode = createPostMode({ locale: 'en_us', payloadBytes: 40, updateLimit: 5 })
    expect(mode.limits['limit.payload.bytes']).toBe(40)
    expect(mode.limits['limit.update.count']).toBe(5)
    const prepared = { draft: draftOf('hello'), resolved: new Map() } as unknown as Prepared<PostDraft>
    const payload = mode.serialize(prepared, serializeContext) as PostPayload
    expect(Object.keys(payload.content)).toEqual(['en_us'])
  })

  it('exposes the wire body the adapter send stage must post', () => {
    expect(postRequestBody({
      msg_type: 'post',
      content: { zh_cn: { content: [[{ tag: 'md', text: 'hi' }]] } },
    })).toEqual({ msg_type: 'post', content: '{"zh_cn":{"content":[[{"tag":"md","text":"hi"}]]}}' })
    expect(postRequestBody({ msg_type: 'file', content: { file_key: 'file_v2_x' } }))
      .toEqual({ msg_type: 'file', content: '{"file_key":"file_v2_x"}' })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The report

describe('post render report', () => {
  it('summarises its degradations in one line', async () => {
    const { bot } = await mount()
    const { report } = await bot.render(target, h('p', 'see ', h('spoiler', 'secret'), ' and ',
      h('button', { type: 'action', id: 'b1', onClick: () => {} }, 'Press')))
    expect(report.degraded.map(entry => entry.tag)).toEqual(['spoiler', 'button'])
    expect(report.summary()).toBe('剧透、按钮已降级；按钮不可点击')
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Adapter wiring

describe('post mode factory', () => {
  it('is a pure function of the config', () => {
    const first = createPostMode()
    const second = createPostMode()
    expect(first).not.toBe(second)
    expect(first.elements.tags()).toEqual(second.elements.tags())
    expect(first.elements.tags()).toEqual(expect.arrayContaining(['text', 'p', 'br', 'at', 'img', 'table']))
  })

  it('registers only the elements a post can carry', () => {
    const tags = createPostMode().elements.tags() as string[]
    for (const tag of ['button', 'details', 'small', 'span', 'channel', 'emoji', 'button-group', 'spoiler']) {
      expect(tags).not.toContain(tag)
    }
  })

  it('sends multi-part content through the real bot pipeline', async () => {
    const { bot } = await mount()
    const result = await bot.send(target, [h('p', 'text'), h('file', { src: 'https://example.com/a.pdf', name: 'a.pdf' })])
    expect(result.handle.parts).toHaveLength(2)
    expect(bot.sentPayloads().map(payload => (payload as PostPayload).msg_type)).toEqual(['post', 'file'])
    expect(bot.last('send')?.index).toBe(1)
  })
})
