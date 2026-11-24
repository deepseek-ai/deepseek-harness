import { describe, expect, it } from 'vitest'
import type { RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { normalize, tags } from '@deepseek-ai/satori-element'
import { fromMarkdown as convert, settledMarkdown } from '@deepseek-ai/cordis-plugin-im-markdown'

/** `<message>` of one markdown document, as the XML-ish form (`toString()` is the tree's canonical shape). */
const xml = (source: string) => normalize(convert(source)).toString()

interface Case {
  name: string
  markdown: string
  /** Expected normalized tree. */
  xml: string
}

/**
 * The corpus: every construct `fromMarkdown` claims to support, plus the awkward inputs that used to break the
 * paragraph-splitting stub (unterminated fences, CJK, reference links, CRLF, empty source).
 */
const corpus: Case[] = [
  {
    name: 'paragraph',
    markdown: 'hello world',
    xml: '<message><p>hello world</p></message>',
  },
  {
    name: 'two paragraphs',
    markdown: 'first\n\nsecond',
    xml: '<message><p>first</p><p>second</p></message>',
  },
  {
    name: 'headings h1 and h6',
    markdown: '# One\n\n###### six',
    xml: '<message><h1>One</h1><h6>six</h6></message>',
  },
  {
    name: 'headings h2 to h5 keep their depth',
    markdown: '## two\n\n### three\n\n#### four\n\n##### five',
    xml: '<message><h2>two</h2><h3>three</h3><h4>four</h4><h5>five</h5></message>',
  },
  {
    name: 'emphasis, strong and the combined form',
    markdown: 'a *b* c **d** ~~e~~',
    xml: '<message><p>a <i>b</i> c <b>d</b> <s>e</s></p></message>',
  },
  {
    name: 'nested emphasis inside strong',
    markdown: '**bold *and italic***',
    xml: '<message><p><b>bold <i>and italic</i></b></p></message>',
  },
  {
    name: 'underscore emphasis',
    markdown: '_a_ __b__',
    xml: '<message><p><i>a</i> <b>b</b></p></message>',
  },
  {
    name: 'inline code keeps markup literal',
    markdown: 'use `a < b` now',
    xml: '<message><p>use <code>a &lt; b</code> now</p></message>',
  },
  {
    name: 'inline code with a backtick run',
    markdown: '`` a`b ``',
    xml: '<message><p><code>a`b</code></p></message>',
  },
  {
    name: 'fenced code with a language',
    markdown: '```ts\nconst a = 1 < 2\n```',
    xml: '<message><pre lang="ts">const a = 1 &lt; 2</pre></message>',
  },
  {
    name: 'fenced code without a language',
    markdown: '```\nplain fence\n```',
    xml: '<message><pre>plain fence</pre></message>',
  },
  {
    name: 'unterminated fence runs to the end of the input',
    markdown: '```js\nconst x = 1\nlet y = 2',
    xml: '<message><pre lang="js">const x = 1\nlet y = 2</pre></message>',
  },
  {
    name: 'indented code block',
    markdown: '    indented code\n    line two',
    xml: '<message><pre>indented code\nline two</pre></message>',
  },
  {
    name: 'empty fenced code stays an empty pre',
    markdown: '```\n```',
    xml: '<message><pre/></message>',
  },
  {
    name: 'unordered list',
    markdown: '- one\n- two',
    xml: '<message><ul><li><p>one</p></li><li><p>two</p></li></ul></message>',
  },
  {
    name: 'ordered list from 1 has no start attribute',
    markdown: '1. one\n2. two',
    xml: '<message><ol><li><p>one</p></li><li><p>two</p></li></ol></message>',
  },
  {
    name: 'ordered list start is preserved',
    markdown: '3. three\n4. four',
    xml: '<message><ol start="3"><li><p>three</p></li><li><p>four</p></li></ol></message>',
  },
  {
    name: 'GFM task list keeps checked state',
    markdown: '- [x] done\n- [ ] todo',
    xml: '<message><ul><li checked><p>done</p></li><li no-checked><p>todo</p></li></ul></message>',
  },
  {
    name: 'nested lists',
    markdown: '- a\n  - b\n    - c\n- d',
    xml: '<message><ul><li><p>a</p><ul><li><p>b</p><ul><li><p>c</p></li></ul></li></ul></li><li><p>d</p></li></ul></message>',
  },
  {
    name: 'loose list items keep one paragraph each',
    markdown: '- a\n\n- b',
    xml: '<message><ul><li><p>a</p></li><li><p>b</p></li></ul></message>',
  },
  {
    name: 'list item with code block and paragraph',
    markdown: '- intro\n\n  ```js\n  x\n  ```',
    xml: '<message><ul><li><p>intro</p><pre lang="js">x</pre></li></ul></message>',
  },
  {
    name: 'blockquote',
    markdown: '> quoted\n> more',
    xml: '<message><blockquote><p>quoted<br/>more</p></blockquote></message>',
  },
  {
    name: 'nested blockquote with a list',
    markdown: '> a\n>\n> > b\n>\n> - c',
    xml: '<message><blockquote><p>a</p><blockquote><p>b</p></blockquote><ul><li><p>c</p></li></ul></blockquote></message>',
  },
  {
    name: 'thematic break',
    markdown: 'a\n\n---\n\nb',
    xml: '<message><p>a</p><hr/><p>b</p></message>',
  },
  {
    name: 'table with alignments and inline code',
    markdown: '| a | b |\n| :- | -: |\n| `x` | y |',
    xml: '<message><table><tr><th align="left"><p>a</p></th><th align="right"><p>b</p></th></tr><tr><td align="left"><p><code>x</code></p></td><td align="right"><p>y</p></td></tr></table></message>',
  },
  {
    name: 'table center alignment and an empty cell',
    markdown: '| a | b |\n| :-: | --- |\n| x |  |',
    xml: '<message><table><tr><th align="center"><p>a</p></th><th><p>b</p></th></tr><tr><td align="center"><p>x</p></td><td/></tr></table></message>',
  },
  {
    name: 'link',
    markdown: 'see [docs](https://e.x/a?b=1&c=2)',
    xml: '<message><p>see <a href="https://e.x/a?b=1&amp;c=2">docs</a></p></message>',
  },
  {
    name: 'autolink',
    markdown: '<https://e.x>',
    xml: '<message><p><a href="https://e.x">https://e.x</a></p></message>',
  },
  {
    name: 'reference link resolves through its definition',
    markdown: 'see [x]\n\n[x]: https://e.x',
    xml: '<message><p>see <a href="https://e.x">x</a></p></message>',
  },
  {
    name: 'image alone becomes a block-level img',
    markdown: '![alt text](https://e.x/a.png)',
    xml: '<message><img src="https://e.x/a.png" alt="alt text"/></message>',
  },
  {
    name: 'image without alt',
    markdown: '![](https://e.x/a.png)',
    xml: '<message><img src="https://e.x/a.png"/></message>',
  },
  {
    name: 'image inside a text run stays inline',
    markdown: 'see ![x](a.png) here',
    xml: '<message><p>see <img src="a.png" alt="x"/> here</p></message>',
  },
  {
    name: 'inline html of the vocabulary becomes an element',
    markdown: 'a <b>raw</b> c',
    xml: '<message><p>a <b>raw</b> c</p></message>',
  },
  {
    name: 'html no element stands for keeps its text',
    markdown: '<div>\nraw\n</div>',
    xml: '<message><p>raw</p></message>',
  },
  {
    name: 'hard break',
    markdown: 'a  \nb',
    xml: '<message><p>a<br/>b</p></message>',
  },
  {
    name: 'soft break keeps the line structure',
    markdown: 'a\nb',
    xml: '<message><p>a<br/>b</p></message>',
  },
  {
    name: 'CJK text with emphasis and code',
    markdown: '中文**加粗**与`代码`',
    xml: '<message><p>中文<b>加粗</b>与<code>代码</code></p></message>',
  },
  {
    name: 'CJK heading and list',
    markdown: '## 标题\n\n- 一\n- 二',
    xml: '<message><h2>标题</h2><ul><li><p>一</p></li><li><p>二</p></li></ul></message>',
  },
  {
    name: 'escaped markup stays literal',
    markdown: 'a \\*not em\\* b',
    xml: '<message><p>a *not em* b</p></message>',
  },
  {
    name: 'CRLF input',
    markdown: 'a\r\n\r\nb',
    xml: '<message><p>a</p><p>b</p></message>',
  },
  {
    name: 'empty source',
    markdown: '',
    xml: '<message/>',
  },
  {
    name: 'whitespace-only source',
    markdown: '  \n\n  ',
    xml: '<message/>',
  },
  {
    name: 'footnote reference and definition degrade to text and blocks',
    markdown: 'text[^1]\n\n[^1]: note',
    xml: '<message><p>text[^1]</p><p>note</p></message>',
  },
  {
    name: 'mixed document',
    markdown: '## T\n\npara with `code`\n\n1. item\n\n> quote\n\n| h |\n| - |\n| c |',
    xml: '<message><h2>T</h2><p>para with <code>code</code></p><ol><li><p>item</p></li></ol><blockquote><p>quote</p></blockquote><table><tr><th><p>h</p></th></tr><tr><td><p>c</p></td></tr></table></message>',
  },
  {
    name: 'inline formatting inside a table cell and a list item',
    markdown: '| h |\n| - |\n| **b** |\n\n- *i* and [a](https://e.x)',
    xml: '<message><table><tr><th><p>h</p></th></tr><tr><td><p><b>b</b></p></td></tr></table><ul><li><p><i>i</i> and <a href="https://e.x">a</a></p></li></ul></message>',
  },
  {
    name: 'literal html gives markdown the elements it has no syntax for',
    markdown: '<u>下划线</u> <spoiler>剧透</spoiler>',
    xml: '<message><p><u>下划线</u> <spoiler>剧透</spoiler></p></message>',
  },
  {
    name: 'html spellings resolve through the tag aliases',
    markdown: '<strong>粗</strong> <em>斜</em> <del>删</del> <ins>下</ins> <spl>透</spl>',
    xml: '<message><p><b>粗</b> <i>斜</i> <s>删</s> <u>下</u> <spoiler>透</spoiler></p></message>',
  },
  {
    name: 'a mention addresses its id and shows the name it wraps',
    markdown: 'hi <at user_id="ou_x">张三</at> and <at id="ou_y">李四</at>',
    xml: '<message><p>hi <at id="ou_x" type="user" name="张三"/> and <at id="ou_y" type="user" name="李四"/></p></message>',
  },
  {
    name: 'a self-closing mention owns no following text',
    markdown: 'hi <at id=ou_x /> there',
    xml: '<message><p>hi <at id="ou_x" type="user"/> there</p></message>',
  },
  {
    name: 'the vocabulary decides which attributes survive',
    markdown: '<span color="red">红</span>',
    xml: '<message><p><span color="red">红</span></p></message>',
  },
  {
    name: 'html nests inside its own elements',
    markdown: '<u><b>粗下划线</b></u>',
    xml: '<message><p><u><b>粗下划线</b></u></p></message>',
  },
  {
    name: 'an emoji keeps the id it addresses and the name it shows',
    markdown: '<emoji id="smile">笑脸</emoji>',
    xml: '<message><p><emoji id="smile" name="笑脸"/></p></message>',
  },
  {
    name: 'an interactive element is not authorable: its text stays',
    markdown: '<button type="action" id="stop">点我</button>',
    xml: '<message><p>点我</p></message>',
  },
  {
    name: 'an element missing its required attribute keeps its text',
    markdown: '<a>无 href 的链接</a>',
    xml: '<message><p>无 href 的链接</p></message>',
  },
  {
    name: 'block-level html joins the blocks around it',
    markdown: '- 一\n\n<details><summary>题</summary>正文</details>',
    xml: '<message><ul><li><p>一</p></li></ul><details><summary>题</summary><p>正文</p></details></message>',
  },
  {
    name: 'an html table is a table',
    markdown: '<table><tr><td>a</td></tr></table>',
    xml: '<message><table><tr><td><p>a</p></td></tr></table></message>',
  },
  {
    name: 'a block element on a line of its own is that block',
    markdown: '<small>小字说明</small>',
    xml: '<message><small>小字说明</small></message>',
  },
  {
    name: 'a block element inside a sentence keeps its text',
    markdown: '前 <small>小字</small> 后',
    xml: '<message><p>前 小字 后</p></message>',
  },
  {
    name: 'a list item outside a list keeps its text',
    markdown: '<li>孤儿项</li>',
    xml: '<message><p>孤儿项</p></message>',
  },
  {
    name: 'a soft break beside inline formatting stays a break',
    markdown: 'first\n**second**\nthird',
    xml: '<message><p>first<br/><b>second</b><br/>third</p></message>',
  },
  {
    name: 'a soft break beside a link stays a break',
    markdown: '[a](https://example.com/a)\nb',
    xml: '<message><p><a href="https://example.com/a">a</a><br/>b</p></message>',
  },
  {
    name: 'a name an object inherits is not a tag',
    markdown: '<constructor>hello</constructor> <toString>x</toString>',
    xml: '<message><p>hello x</p></message>',
  },
  {
    name: 'Feishu everyone id is the all mention, not a user',
    markdown: '<at user_id="all">所有人</at> <at id="here"></at>',
    xml: '<message><p><at type="all" name="所有人"/> <at type="here"/></p></message>',
  },
]

describe('fromMarkdown: element trees', () => {
  for (const { name, markdown, xml: expected } of corpus) {
    it(name, () => {
      expect(xml(markdown)).toBe(expected)
    })
  }

  it('returns blocks, never a <message> envelope', () => {
    const blocks = convert('a\n\nb')
    expect(blocks.map(block => block.type)).toEqual(['p', 'p'])
    expect(blocks.every(block => block.type !== 'message')).toBe(true)
    expect(convert('')).toEqual([])
  })

  it('only emits vocabulary tags', () => {
    for (const { markdown } of corpus) {
      const walk = (nodes: readonly { type: string; children: { type: string; children: any[] }[] }[]) => {
        for (const node of nodes) {
          expect(tags).toContain(node.type)
          walk(node.children)
        }
      }
      walk(convert(markdown))
    }
  })

  it('takes the language of a fence verbatim and drops it when absent', () => {
    expect(convert('```TypeScript title=x\nx\n```')[0]!.attrs).toMatchObject({ lang: 'TypeScript' })
    expect(convert('```\nx\n```')[0]!.attrs).toEqual({})
  })

  it('marks standalone images as block media and nested ones as inline', () => {
    const [media] = convert('![a](b.png)')
    expect(media!.type).toBe('img')
    const [paragraph] = convert('x ![a](b.png)')
    expect(paragraph!.type).toBe('p')
    expect(paragraph!.children[1]!.type).toBe('img')
  })

  it('keeps task-list state as a boolean attribute', () => {
    const [list] = convert('- [x] done\n- [ ] todo\n- plain')
    const items = list!.children as { attrs: { checked?: boolean } }[]
    expect(items.map(item => item.attrs.checked)).toEqual([true, false, undefined])
  })

  it('emits align only when the delimiter row declares it', () => {
    const [table] = convert('| a | b |\n| --- | --- |\n| x | y |')
    const header = table!.children[0]!.children as { type: string; attrs: Record<string, unknown> }[]
    const body = table!.children[1]!.children as { type: string; attrs: Record<string, unknown> }[]
    expect(header.map(cell => cell.type)).toEqual(['th', 'th'])
    expect(body.map(cell => cell.type)).toEqual(['td', 'td'])
    expect(header.every(cell => cell.attrs.align === undefined)).toBe(true)
    expect(body.every(cell => cell.attrs.align === undefined)).toBe(true)
  })

  it('keeps a mention addressable and shows the name it wraps', () => {
    const [paragraph] = convert('hi <at user_id="ou_x">张三</at>')
    const mention = paragraph!.children[1]!
    expect(mention.type).toBe('at')
    expect(mention.attrs).toEqual({ type: 'user', id: 'ou_x', name: '张三' })
  })

  it('cannot author the interactive half of the vocabulary', () => {
    const source = '<button type="action" id="stop">b</button><input type="checkbox"/>'
      + '<select><option value="1">o</option></select><form name="f"><p>x</p></form>'
      + '<fallback><case><p>c</p></case></fallback><raw platform="lark" type="card">{}></raw>'
    const seen: string[] = []
    const walk = (nodes: readonly { type: string; children: unknown[] }[]) => {
      for (const node of nodes) {
        seen.push(node.type)
        walk((node.children ?? []) as readonly { type: string; children: unknown[] }[])
      }
    }
    walk(convert(source))
    for (const tag of ['button', 'input', 'select', 'option', 'form', 'fallback', 'case', 'raw']) {
      expect(seen).not.toContain(tag)
    }
    // Their text is what a reader gets instead.
    expect(seen.filter(tag => tag === 'text').length).toBeGreaterThan(0)
  })
})

// ---- text conservation ---------------------------------------------------------------------------------------------

/**
 * mdast leaf text: everything the source says in words, before any rendering decision. A `footnoteReference` has no
 * leaf text of its own, and the converter keeps it visible as the literal `[^label]` marker — the one place where the
 * tree adds characters the source does not spell out. Raw HTML contributes its text and its tags are markup, so they
 * are stripped here: the reader sees what a tag wraps, never the tag.
 */
function sourceText(nodes: readonly RootContent[] | readonly { type: string; [key: string]: any }[]): string {
  let out = ''
  for (const node of nodes as readonly { type: string; value?: string; label?: string; identifier?: string; children?: any[] }[]) {
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
      out += node.value ?? ''
    } else if (node.type === 'html') {
      out += String(node.value ?? '').replace(/<[^>]*>/g, '')
    } else if (node.type === 'footnoteReference') {
      out += `[^${node.label ?? node.identifier}]`
    } else if (Array.isArray(node.children)) {
      out += sourceText(node.children)
    }
  }
  return out
}

/**
 * Every text run in the produced element tree, plus the labels an element carries in `name` instead of children
 * (`<at user_id="ou_x">张三</at>` shows 张三 without holding it as content).
 */
function treeText(nodes: readonly { type: string; attrs: Record<string, any>; children: any[] }[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += String(node.attrs.content ?? '')
    else {
      if (node.type === 'at' || node.type === 'emoji' || node.type === 'channel') out += String(node.attrs.name ?? '')
      if (Array.isArray(node.children)) out += treeText(node.children)
    }
  }
  return out
}

const strip = (value: string) => value.replace(/\s+/g, '')

function mdastLeaves(source: string) {
  return fromMarkdown(source.replace(/\r\n?/g, '\n'), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }).children
}

describe('fromMarkdown: text conservation', () => {
  it('keeps every character of the source text', () => {
    for (const { name, markdown } of corpus) {
      const before = strip(sourceText(mdastLeaves(markdown)))
      const after = strip(treeText(convert(markdown)))
      expect({ name, text: after }).toEqual({ name, text: before })
    }
  })

  it('conserves text through a normalized message', () => {
    const content = '## 标题\n\n正文 **加粗** `代码`\n\n- 一\n- 二'
    const message = normalize(convert(content))
    expect(strip(treeText(message.children))).toBe(strip(sourceText(mdastLeaves(content))))
    expect(message.children.map(child => child.type)).toEqual(['h2', 'p', 'ul'])
  })

  it('survives arbitrary punctuation without throwing', () => {
    for (const source of ['#', '*', '`', '```', '|', '>', '~~', '[', '![]', '\\', '|||\n|-|\n|x|', '\u0000\u0001']) {
      expect(() => convert(source)).not.toThrow()
    }
  })
})


describe('settledMarkdown', () => {
  it('keeps everything before the last top-level block', () => {
    expect(settledMarkdown('**a')).toBe('')
    expect(settledMarkdown('done\n\n**b')).toBe('done')
    expect(settledMarkdown('## t\n\n- x\n- y\n\n```js\nopen')).toBe('## t\n\n- x\n- y')
    expect(settledMarkdown('a\r\n\r\nb')).toBe('a')
    expect(settledMarkdown('')).toBe('')
  })

  it('keeps every settled state a prefix of the complete document', () => {
    const source = '好的 **加粗** 与 `代码`\n\n1. 一\n2. 二\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n标题\n---\n\n```ts\nx\n```\n\n尾'
    let previous: string[] = []
    for (let n = 1; n <= source.length; n++) {
      const blocks = convert(settledMarkdown(source.slice(0, n))).map(block => block.toString())
      expect(blocks.slice(0, previous.length)).toEqual(previous)
      previous = blocks
    }
  })
})