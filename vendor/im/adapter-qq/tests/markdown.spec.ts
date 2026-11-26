/** QQ `markdown` mode: conformance, goldens, escaping, block layout and linkPolicy. */
import { describe, expect, it } from 'vitest'
import { h } from '@deepseek-ai/satori-element'
import { expectGolden, renderCorpus, runConformance } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import { escapeMarkdown } from '../src/modes/index.ts'
import { goldens, group, mountQQ } from './mount.ts'

const markdown = (content: string) => ({ msg_type: 2, markdown: { content } })
const text = (content: string) => ({ msg_type: 0, content })

describe('QQ markdown mode', () => {
  for (const linkPolicy of ['text', 'keep'] as const) {
    it(`passes conformance (linkPolicy ${linkPolicy})`, async () => {
      const bot = await mountQQ({ markdown: true, linkPolicy })
      const result = await runConformance(bot, 'markdown', { target: group })
      expect(result.problems).toEqual([])
    })
  }

  it('matches the corpus golden', async () => {
    const bot = await mountQQ({ markdown: true })
    const rendered = await renderCorpus(bot, 'markdown', { target: group })
    expectGolden('markdown', rendered.map(item => ({ name: item.name, payloads: item.payloads })), { dir: goldens })
  })

  it('escapes markdown metacharacters and defuses line-start markers', () => {
    // `\#` and `1\.` reach the chat with the backslash still in the text, so a block marker takes an invisible U+200B.
    expect(escapeMarkdown('a*b_c [x](y) <@1> #tag')).toBe('a\\*b\\_c \\[x\\](y) \\<@1\\> #tag')
    expect(escapeMarkdown('- item\n1. first')).toBe('\u200B- item\n\u200B1. first')
  })

  it('renders styles, headings, lists, quotes and rules with blank-line paragraphs', async () => {
    const bot = await mountQQ({ markdown: true })
    const { payloads } = await bot.render(group, [
      h('h1', 'Title'),
      h('p', h('b', 'bold '), h('i', 'it'), ' ', h('s', 'gone')),
      h('ul', h('li', 'one'), h('li', 'two', h('ul', h('li', 'nested')))),
      h('ol', { start: 3 }, h('li', 'three')),
      h('blockquote', h('p', 'q1'), h('p', 'q2')),
      h('hr'),
      h('p', 'a', h('br'), h('br'), 'b'),
    ])
    expect(payloads).toEqual([markdown([
      '# Title',
      '**bold** *it* ~~gone~~',
      '- one\n- two\n  - nested',
      '3. three',
      '> q1\n>\n> q2',
      '***',
      'a\n\u200B\nb',
    ].join('\n\n'))])
  })

  it('renders user and @everyone mentions as the tags QQ notifies from', async () => {
    // QQ reads `<qqbot-at-user>` and `<qqbot-at-everyone />` only inside a markdown body; the text mode keeps the
    // readable `@name` fallback, so a message carrying a mention resolves to this mode.
    const bot = await mountQQ({ markdown: true })
    const { payloads } = await bot.render(group, [
      h('p', h('at', { type: 'user', id: 'u-alice', name: 'Alice' }), ' please take a look'),
      h('p', h('at', { type: 'all', name: '所有人' }), ' build is green again'),
      // `here` and `role` have no QQ tag: they keep the core's readable fallback.
      h('p', h('at', { type: 'here', name: '在线成员' })),
    ])
    expect(payloads).toEqual([markdown([
      '<qqbot-at-user id="u-alice" /> please take a look',
      '<qqbot-at-everyone /> build is green again',
      '@在线成员',
    ].join('\n\n'))])
  })

  it('renders inline code as a plain span and a code block as a verbatim fence', async () => {
    const bot = await mountQQ({ markdown: true })
    const code = 'const a = 1\n\nif (a) {\n  b(`x|y`) // #1\n}'
    const { payloads } = await bot.render(group, [
      h('p', 'a ', h('code', 'x|y'), ' b'),
      h('pre', { lang: 'ts' }, code),
      h('pre', 'no lang'),
    ])
    expect(payloads).toEqual([markdown([
      'a `x|y` b',
      '```ts\n' + code + '\n```',
      '```\nno lang\n```',
    ].join('\n\n'))])
  })

  it('keeps a fenced block on lines of the list item or quote that holds it', async () => {
    const bot = await mountQQ({ markdown: true })
    const { payloads } = await bot.render(group, [
      h('ul', h('li', 'one', h('pre', { lang: 'js' }, 'a()'))),
      h('blockquote', h('p', 'q'), h('pre', 'echo')),
    ])
    // A fence that does not start on a line of its own is not a fence. A list indents every line of its item and a
    // quote prefixes every line it owns, code included; otherwise the fence stays mid-line, its closing marker joins
    // the next block, and everything after it is swallowed into that code block.
    expect(payloads).toEqual([markdown([
      '- one\n  ```js\n  a()\n  ```',
      '> q\n> ```\n> echo\n> ```',
    ].join('\n\n'))])
  })

  it('embeds an image in the message body when the content mixes it with text', async () => {
    const bot = await mountQQ({ markdown: true })
    const { payloads } = await bot.render(group, [h('p', '看图 ', h('img', { src: 'https://example.com/a.png', alt: '示例' }), ' 后面')])
    // One message, not a text/media/text split: the picture stays where the content put it, with the dimensions QQ
    // requires (`0px` keeps the source size) and the uploaded resource the platform fetches itself.
    expect(payloads).toEqual([markdown('看图 ![示例 #0px #0px](qqbot-media://dryrun:image:https://example.com/a.png) 后面')])
  })

  it('keeps a picture that stands alone in the text mode, with its own media message', async () => {
    const bot = await mountQQ({ markdown: true })
    const { payloads } = await bot.render(group, [h('img', { src: 'https://example.com/a.png', alt: '示例' })])
    // Nothing to interleave, so the cheaper `text` mode wins the tie and the picture keeps its own message.
    expect(payloads).toEqual([{ msg_type: 7, content: ' ', media: { file_info: 'dryrun:image:https://example.com/a.png' } }])
  })

  it('keeps a fence longer than any backtick run of the code and does not escape its body', () => {
    return mountQQ({ markdown: true }).then(async bot => {
      const { payloads } = await bot.render(group, [
        h('pre', 'say ```hi``` and *not* bold'),
        h('p', h('code', '``')),
      ])
      expect(payloads).toEqual([markdown('````\nsay ```hi``` and *not* bold\n````\n\n``` `` ```')])
    })
  })

  it('lays a simple table out as a monospace grid inside a fence', async () => {
    const bot = await mountQQ({ markdown: true })
    const { payloads } = await bot.render(group, [
      h('table',
        h('tr', h('th', 'File'), h('th', { align: 'right' }, 'Size')),
        h('tr', h('td', 'a.ts'), h('td', '12'))),
    ])
    expect(payloads).toEqual([markdown('```\nFile | Size\n-----+-----\na.ts |   12\n```')])
  })

  it('applies linkPolicy to the element table and the rendered text', async () => {
    const content = h('p', h('a', { href: 'https://example.com/x' }, 'docs'))
    // `linkPolicy: 'text'` degrades the link in both modes, so the resolution tie keeps the cheaper `text` mode.
    const plain = await mountQQ({ markdown: true })
    expect(plain.modes.markdown.elements.has('element.a')).toBe(false)
    expect((await plain.render(group, content)).payloads).toEqual([text('docs')])
    // `keep` makes the link native in the markdown mode, which then degrades nothing and wins the resolution.
    const keep = await mountQQ({ markdown: true, linkPolicy: 'keep' })
    expect(keep.modes.markdown.elements.has('element.a')).toBe(true)
    expect((await keep.render(group, content)).payloads).toEqual([markdown('[docs](https://example.com/x)')])
  })

  it('declares the markdown elements only in the markdown mode', async () => {
    const plain = await mountQQ()
    const md = await mountQQ({ markdown: true })
    expect(plain.modes.text.elements.has('element.b')).toBe(false)
    expect(md.modes.text.elements.has('element.b')).toBe(false)
    expect(md.modes.markdown.elements.has('element.b')).toBe(true)
    expect(md.modes.markdown.elements.has('element.img')).toBe(true)
    expect(md.modes.markdown.elements.has('element.button')).toBe(false)
  })
})
