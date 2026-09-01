// @vitest-environment jsdom
// Incremental streaming behavior: a MarkdownText kept mounted across
// append-only rerenders must show, at every step, exactly the DOM a fresh
// mount of the same prefix shows, while reusing the frozen blocks' DOM nodes
// instead of remounting them.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Root, RootContent } from 'mdast'
import { MarkdownText } from './markdown-test-components.tsx'
import { IncrementalMarkdownParser } from '../src/markdown/incremental.ts'
import { parseGfm } from '../src/markdown/parse.ts'

afterEach(cleanup)

/**
 * A many-block document exercising every freeze-sensitive construct. The
 * prefix-equivalence property below holds only while no reference or
 * footnote definition lands on the far side of a freeze boundary from its
 * use: a fresh mount parses everything in one tree while the live stream's
 * frozen blocks are already baked (the fingerprint test demonstrates the
 * documented deviation). Keep definitions adjacent to their references when
 * extending this corpus.
 */
const STREAM_DOC = [
  '# Title',
  '',
  'First paragraph with **strong** and `code`.',
  '',
  '- list item one',
  '- list item two',
  '',
  '  continuation of item two',
  '',
  'Setext heading',
  '===',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x = 1',
  '',
  'still inside the fence',
  '```',
  '',
  '> quote with lazy',
  'continuation line',
  '',
  'Uses a footnote[^n] twice[^n].',
  '',
  '[^n]: The footnote body.',
  '',
  'Closing paragraph after enough blocks to freeze everything above.',
  '',
  'One more tail block.',
].join('\n')

describe('incremental streaming rendering', () => {
  for (const chunkSize of [1, 3, 7, 16]) {
    it(`matches a fresh render at every prefix (chunk=${chunkSize})`, { timeout: 20_000 }, () => {
      const live = render(<MarkdownText text="" streaming />)
      for (let end = chunkSize; end < STREAM_DOC.length + chunkSize; end += chunkSize) {
        const prefix = STREAM_DOC.slice(0, Math.min(end, STREAM_DOC.length))
        live.rerender(<MarkdownText text={prefix} streaming />)
        const fresh = render(<MarkdownText text={prefix} streaming />)
        expect(live.container.innerHTML).toBe(fresh.container.innerHTML)
        fresh.unmount()
      }
      live.unmount()
    })
  }

  it('keeps frozen block DOM nodes across freezes instead of remounting', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `Paragraph number ${i}.`)
    const first = `${paragraphs[0]}\n\n`
    const live = render(<MarkdownText text={first} streaming />)
    const firstBlock = live.container.querySelector('p')
    expect(firstBlock?.textContent).toBe(paragraphs[0])
    live.rerender(<MarkdownText text={paragraphs.join('\n\n')} streaming />)
    // Same DOM node instance: the block kept its key across the freeze boundary.
    expect(live.container.querySelector('p')).toBe(firstBlock)
    expect(live.container.querySelectorAll('p')).toHaveLength(paragraphs.length)
    live.unmount()
  })

  it('recovers when the text diverges instead of appending', () => {
    const live = render(<MarkdownText text={'alpha\n\nbeta\n\ngamma\n\ndelta'} streaming />)
    live.rerender(<MarkdownText text={'totally\n\ndifferent\n\ndocument'} streaming />)
    const fresh = render(<MarkdownText text={'totally\n\ndifferent\n\ndocument'} streaming />)
    expect(live.container.innerHTML).toBe(fresh.container.innerHTML)
    live.unmount()
    fresh.unmount()
  })

  it('drops the streaming cache when the copy labels change identity', () => {
    const doc = ['```ts', 'const a = 1', '```', '', 'p1', '', 'p2', '', 'p3'].join('\n')
    const live = render(
      <MarkdownText text={doc} streaming codeLabels={{ copyLabel: 'Copy', copiedLabel: 'Copied' }} />,
    )
    expect([...live.container.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Copy'])
    live.rerender(
      <MarkdownText text={doc} streaming codeLabels={{ copyLabel: 'Kopieren', copiedLabel: 'Kopiert' }} />,
    )
    expect([...live.container.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Kopieren'])
    live.unmount()
  })

  it('settles into the full math-enabled render after streaming', () => {
    const doc = 'Value $E = mc^2$ inline.\n\nSecond.\n\nThird.\n\nFourth.'
    const live = render(<MarkdownText text={doc} streaming />)
    expect(live.container.querySelector('.katex')).toBeNull()
    live.rerender(<MarkdownText text={doc} />)
    const settled = render(<MarkdownText text={doc} />)
    expect(live.container.innerHTML).toBe(settled.container.innerHTML)
    expect(live.container.querySelector('.katex')).not.toBeNull()
    live.unmount()
    settled.unmount()
  })

  it('keeps a highlighted fence mounted across the final full-document parse', () => {
    const doc = 'before.\n\n```ts\nconst answer = 42\n```\n\nafter.'
    const live = render(<MarkdownText text={doc} streaming />)
    const line = live.container.querySelector('pre.shiki .line')
    expect(line).not.toBeNull()
    live.rerender(<MarkdownText text={doc} />)
    expect(live.container.querySelector('pre.shiki .line')).toBe(line)
    live.unmount()
  })
})

describe('incremental parsing is actually in effect', () => {
  it('hands the grammar only the source tail once blocks freeze', () => {
    const calls: string[] = []
    const recording = (text: string): Root => {
      calls.push(text)
      return parseGfm(text)
    }
    const parser = new IncrementalMarkdownParser(recording)
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with some words.`)
    let text = ''
    for (const paragraph of paragraphs) {
      text += `${paragraph}\n\n`
      parser.update(text)
    }
    expect(text.length).toBeGreaterThan(1500)
    // Warm-up aside, every parse sees only the unstable tail: bounded by a
    // few paragraphs, not the growing document.
    const steady = calls.slice(5)
    expect(Math.max(...steady.map(call => call.length))).toBeLessThan(200)
    expect(steady.every(call => !call.includes('Paragraph number 0 '))).toBe(true)
    // Cumulative parsed bytes stay linear in the document; full re-parsing
    // would have accumulated ~40/2 times the document length here.
    const totalParsed = calls.reduce((sum, call) => sum + call.length, 0)
    expect(totalParsed).toBeLessThan(text.length * 5)
  })

  it('parses an open fence through bounded grammar slices as completed lines accumulate', () => {
    const calls: string[] = []
    const recording = (text: string): Root => {
      calls.push(text)
      return parseGfm(text)
    }
    const parser = new IncrementalMarkdownParser(recording)
    let text = '```ts\n'
    let result = parser.update(text)
    for (let index = 0; index < 800; index += 1) {
      text += `const value${String(index)} = ${String(index)}\n`
      result = parser.update(text)
    }
    const parsed = calls.reduce((sum, call) => sum + call.length, 0)
    expect(Math.max(...calls.slice(10).map(call => call.length))).toBeLessThan(80)
    expect(parsed).toBeLessThan(text.length * 4)
    expect(result.tail.at(-1)?.node).toEqual(parseGfm(text).children[0])
  })

  it('shows the documented streaming fingerprint: a definition frozen earlier no longer resolves a new reference, and settling heals it', () => {
    const doc = [
      '[ref]: https://example.com/target',
      '',
      'Paragraph one keeps the definition company.',
      '',
      'Paragraph two pushes the freeze boundary.',
      '',
      'Paragraph three freezes the definition out.',
      '',
      'See [the link][ref] for details.',
    ].join('\n')
    const head = doc.slice(0, doc.indexOf('See'))
    const live = render(<MarkdownText text={head} streaming />)
    live.rerender(<MarkdownText text={doc} streaming />)
    // The tail re-parse cannot see the frozen definition, so the reference
    // stays literal — the direct observable that the whole text was NOT
    // re-parsed (a one-shot mount of the same text resolves it).
    expect(live.container.querySelector('a')).toBeNull()
    expect(live.container.textContent).toContain('[the link][ref]')
    const fresh = render(<MarkdownText text={doc} streaming />)
    expect(fresh.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/target')
    fresh.unmount()
    // The settled swap re-parses everything and heals the deviation.
    live.rerender(<MarkdownText text={doc} />)
    expect(live.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/target')
    live.unmount()
  })
})

describe('freeze dynamics around frontier-sensitive constructs', () => {
  it('an unclosed fence pins the tail: nothing freezes until it closes', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    let text = 'p1.\n\np2.\n\np3.\n\n```ts\n'
    const opened = parser.update(text)
    const frozenAtOpen = opened.frozen.length
    expect(opened.tail[opened.tail.length - 1]?.node.type).toBe('code')
    for (const line of ['const a = 1\n', '\n', 'looks like a paragraph\n', '- looks like a list\n']) {
      text += line
      const grown = parser.update(text)
      // The fence swallows everything appended, so the block census cannot
      // grow and the freeze boundary must hold still.
      expect(grown.frozen.length).toBe(frozenAtOpen)
      expect(grown.tail[grown.tail.length - 1]?.node.type).toBe('code')
    }
    text += '```\n\nafter one.\n\nafter two.\n'
    const closed = parser.update(text)
    expect(closed.frozen.length).toBeGreaterThan(frozenAtOpen)
    const frozenCode = closed.frozen.find(block => block.node.type === 'code')?.node
    expect(frozenCode?.type === 'code' && frozenCode.value).toContain('looks like a list')
  })

  it('keeps indented CRLF fence nodes equal to a fresh parse, then falls back when the fence closes', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    const opening = 'p1.\n\np2.\n\np3.\n\n  ```ts\r\n'
    const suffix = '    const a = 1\r\n   const b = 2\r\n  ```\r\nafter'
    let text = ''
    for (const char of `${opening}${suffix}`) {
      text += char
      const result = parser.update(text)
      const actual = [...result.frozen, ...result.tail].at(-1)
      const expected = parseGfm(text).children.at(-1)
      expect(actual?.key).toBe(expected?.position?.start.offset)
      expect(actual?.node.type).toBe(expected?.type)
      if (actual?.node.type === 'code' && expected?.type === 'code') {
        expect({ lang: actual.node.lang, meta: actual.node.meta, value: actual.node.value })
          .toEqual({ lang: expected.lang, meta: expected.meta, value: expected.value })
      }
    }
  })

  it('preserves lone-CR fence lines and ignores indented code as a fence frontier', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    let text = '```ts\rfirst\r'
    parser.update(text)
    text += 'second\rthird'
    const result = parser.update(text)
    expect(result.tail.at(-1)?.node).toEqual(parseGfm(text).children.at(-1))

    const indented = '    alpha\n    beta\n'
    const indentedResult = new IncrementalMarkdownParser(parseGfm).update(indented)
    expect(indentedResult.tail.at(-1)?.node).toEqual(parseGfm(indented).children.at(-1))
  })

  it('falls back to the full grammar tail when a custom grammar rejects fence slices', () => {
    type Corruption = 'many' | 'paragraph' | 'mismatch'
    const custom = (corruption: Corruption): ((text: string) => Root) => (text) => {
      if (!text.startsWith('```\n')) return parseGfm(text)
      if (corruption === 'many') return parseGfm('one\n\ntwo')
      if (corruption === 'paragraph') return parseGfm('one')
      const root = parseGfm(text)
      const node = root.children[0]
      if (node?.type === 'code') node.value += 'mismatch'
      return root
    }
    const cases = [
      { corruption: 'many' as const, text: '```ts\nfirst' },
      { corruption: 'paragraph' as const, text: '```ts\nfirst' },
      { corruption: 'many' as const, text: '```ts\nfirst\nsecond\nthird' },
      { corruption: 'mismatch' as const, text: '```ts\nfirst' },
    ]
    for (const { corruption, text } of cases) {
      const result = new IncrementalMarkdownParser(custom(corruption)).update(text)
      expect(result.tail.at(-1)?.node).toEqual(parseGfm(text).children.at(-1))
    }

    const positionless = new IncrementalMarkdownParser((text) => {
      const root = parseGfm(text)
      for (const node of root.children) delete node.position
      return root
    }).update('```ts\nfirst')
    expect(positionless.tail.at(-1)?.node.type).toBe('code')
  })

  it('abandons an installed fence frontier when later custom-grammar slices fail', () => {
    let syntheticCall = 0
    let reject: 'none' | 'first' | 'second' = 'none'
    const custom = (text: string): Root => {
      if (!text.startsWith('```\n')) return parseGfm(text)
      syntheticCall += 1
      if (reject === 'first' && syntheticCall === 1) return parseGfm('one\n\ntwo')
      if (reject === 'second' && syntheticCall === 2) return parseGfm('one\n\ntwo')
      return parseGfm(text)
    }

    const pendingParser = new IncrementalMarkdownParser(custom)
    let text = '```ts\nfirst\nsecond'
    pendingParser.update(text)
    syntheticCall = 0
    reject = 'first'
    text += ' tail'
    expect(pendingParser.update(text).tail.at(-1)?.node).toEqual(parseGfm(text).children.at(-1))

    reject = 'none'
    syntheticCall = 0
    const stableParser = new IncrementalMarkdownParser(custom)
    text = '```ts\nfirst\nsecond'
    stableParser.update(text)
    syntheticCall = 0
    reject = 'second'
    text += '\nthird\nfourth'
    expect(stableParser.update(text).tail.at(-1)?.node).toEqual(parseGfm(text).children.at(-1))
  })

  it('a list can keep extending across blank lines until it freezes whole', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    let text = 'intro.\n\nsecond.\n\nthird.\n\n- item a\n- item b\n'
    const before = parser.update(text)
    const frozenBefore = before.frozen.length
    text += '\n- item c\n'
    const extended = parser.update(text)
    expect(extended.frozen.length).toBe(frozenBefore)
    const tailList = extended.tail[extended.tail.length - 1]?.node
    expect(tailList?.type === 'list' && tailList.children).toHaveLength(3)
    text += '\nafter.\n\nmore.\n\nend.\n'
    const after = parser.update(text)
    const frozenList = after.frozen.find(block => block.node.type === 'list')?.node
    expect(frozenList?.type === 'list' && frozenList.children).toHaveLength(3)
  })

  it('keeps every previously frozen key as a stable prefix across the stream', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    let previous: readonly number[] = []
    for (let end = 7; end < STREAM_DOC.length + 7; end += 7) {
      const { frozen } = parser.update(STREAM_DOC.slice(0, Math.min(end, STREAM_DOC.length)))
      const keys = frozen.map(block => block.key)
      expect(keys.slice(0, previous.length)).toEqual(previous)
      previous = keys
    }
    expect(previous.length).toBeGreaterThan(4)
  })
})

describe('multibyte content', () => {
  const CJK_DOC = [
    '# 标题 🎉',
    '',
    '这是一段包含 **加粗**、`行内代码` 与表情 😀🚀 的中文段落。',
    '',
    '- 列表项一 ✅',
    '- 列表项二',
    '',
    '> 引用一行,带表情 🐟',
    '',
    '```',
    '中文代码 🎯',
    '```',
    '',
    '| 键 | 值 |',
    '| --- | --- |',
    '| 甲 | 乙 |',
    '',
    '结尾段落,足够多的块让前面全部冻结。🌊',
  ].join('\n')

  it('code-unit chunking (splitting surrogate pairs mid-stream) matches fresh renders', () => {
    const live = render(<MarkdownText text="" streaming />)
    for (let end = 1; end < CJK_DOC.length + 1; end += 1) {
      const prefix = CJK_DOC.slice(0, Math.min(end, CJK_DOC.length))
      live.rerender(<MarkdownText text={prefix} streaming />)
      const fresh = render(<MarkdownText text={prefix} streaming />)
      expect(live.container.innerHTML).toBe(fresh.container.innerHTML)
      fresh.unmount()
    }
    live.unmount()
  })

  it('freeze-cut offsets agree with one-shot parse offsets on astral content', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    let result = parser.update(CJK_DOC.slice(0, 3))
    for (let end = 6; end < CJK_DOC.length + 3; end += 3) {
      result = parser.update(CJK_DOC.slice(0, Math.min(end, CJK_DOC.length)))
    }
    const oneShot = parseGfm(CJK_DOC).children.map(node => node.position?.start.offset)
    expect([...result.frozen, ...result.tail].map(block => block.key)).toEqual(oneShot)
    expect(result.frozen.length).toBeGreaterThan(3)
  })
})

describe('streaming composition across freezes', () => {
  it('continues footnote numbering from frozen references and lists all definitions', () => {
    const doc = [
      'Alpha uses a footnote[^a].',
      '',
      '[^a]: First note body.',
      '',
      'Filler one.',
      '',
      'Filler two.',
      '',
      'Filler three.',
      '',
      'Beta uses another[^b].',
      '',
      '[^b]: Second note body.',
    ].join('\n')
    const head = doc.slice(0, doc.indexOf('Beta'))
    const live = render(<MarkdownText text={head} streaming />)
    live.rerender(<MarkdownText text={doc} streaming />)
    expect([...live.container.querySelectorAll('p sup')].map(sup => sup.textContent)).toEqual(['1', '2'])
    expect([...live.container.querySelectorAll('section.footnotes li')].map(li => li.id))
      .toEqual(['user-content-fn-a', 'user-content-fn-b'])
    expect(live.container.querySelector('section.footnotes')?.textContent).toContain('First note body. ↩')
    const fresh = render(<MarkdownText text={doc} streaming />)
    expect(live.container.innerHTML).toBe(fresh.container.innerHTML)
    fresh.unmount()
    live.unmount()
  })

  it('keeps every frozen block DOM node through the rest of the stream', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Stable paragraph ${i}.`)
    const half = `${paragraphs.slice(0, 6).join('\n\n')}\n\n`
    const live = render(<MarkdownText text={half} streaming />)
    const captured = [...live.container.querySelectorAll('p')]
    expect(captured.length).toBe(6)
    let text = half
    for (const paragraph of paragraphs.slice(6)) {
      text += `${paragraph}\n\n`
      live.rerender(<MarkdownText text={text} streaming />)
    }
    const finalNodes = [...live.container.querySelectorAll('p')]
    expect(finalNodes.slice(0, 6)).toEqual(captured)
    expect(finalNodes).toHaveLength(12)
    live.unmount()
  })

  it('renders an empty document for definition-only streams, including trailing blank lines', () => {
    const doc = '[a]: https://example.com/1\n\n[b]: https://example.com/2\n\n[c]: https://example.com/3\n\n[d]: https://example.com/4'
    const live = render(<MarkdownText text={doc.slice(0, 30)} streaming />)
    live.rerender(<MarkdownText text={doc} streaming />)
    live.rerender(<MarkdownText text={`${doc}\n\n\n`} streaming />)
    const fresh = render(<MarkdownText text={`${doc}\n\n\n`} streaming />)
    expect(live.container.innerHTML).toBe(fresh.container.innerHTML)
    expect(live.container.querySelector('div')?.childNodes).toHaveLength(0)
    fresh.unmount()
    live.unmount()
  })

  it('survives streaming → settled → streaming prop flips with a fresh incremental state', () => {
    const live = render(<MarkdownText text={'a.\n\nb.'} streaming />)
    live.rerender(<MarkdownText text={'a.\n\nb.'} />)
    const settled = render(<MarkdownText text={'a.\n\nb.'} />)
    expect(live.container.innerHTML).toBe(settled.container.innerHTML)
    settled.unmount()
    live.rerender(<MarkdownText text={'a.\n\nb.\n\nc.\n\nd.\n\ne.'} streaming />)
    const fresh = render(<MarkdownText text={'a.\n\nb.\n\nc.\n\nd.\n\ne.'} streaming />)
    expect(live.container.innerHTML).toBe(fresh.container.innerHTML)
    fresh.unmount()
    live.unmount()
  })

  it('matches fresh renders under irregular deterministic chunk sizes', () => {
    let seed = 42
    const nextSize = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return 1 + (seed % 13)
    }
    const live = render(<MarkdownText text="" streaming />)
    let end = 0
    while (end < STREAM_DOC.length) {
      end = Math.min(end + nextSize(), STREAM_DOC.length)
      const prefix = STREAM_DOC.slice(0, end)
      live.rerender(<MarkdownText text={prefix} streaming />)
      const fresh = render(<MarkdownText text={prefix} streaming />)
      expect(live.container.innerHTML).toBe(fresh.container.innerHTML)
      fresh.unmount()
    }
    live.unmount()
  })
})

describe('IncrementalMarkdownParser', () => {
  it('freezes all but the trailing two blocks and keeps freezing as blocks appear', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    const first = parser.update('a\n\nb\n\nc\n\nd\n\ne')
    expect(first.frozen.map(b => b.node.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(first.tail).toHaveLength(2)
    const second = parser.update('a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng')
    expect(second.frozen).toHaveLength(5)
    expect(second.tail).toHaveLength(2)
    // Previously returned frozen entries keep their identity and keys.
    expect(second.frozen.slice(0, 3)).toEqual(first.frozen)
    expect(second.generation).toBe(first.generation)
  })

  it('holds every block in the tail until more than two exist', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    const result = parser.update('only\n\ntwo blocks')
    expect(result.frozen).toHaveLength(0)
    expect(result.tail).toHaveLength(2)
  })

  it('returns the cached result for identical input', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    const first = parser.update('a\n\nb\n\nc')
    expect(parser.update('a\n\nb\n\nc')).toBe(first)
  })

  it('bumps the generation and discards frozen blocks on non-append input', () => {
    const parser = new IncrementalMarkdownParser(parseGfm)
    const before = parser.update('a\n\nb\n\nc\n\nd')
    expect(before.frozen.length).toBeGreaterThan(0)
    const after = parser.update('different')
    expect(after.generation).toBe(before.generation + 1)
    expect(after.frozen).toHaveLength(0)
    expect(after.tail.map(b => b.node.type)).toEqual(['paragraph'])
  })

  it('keys blocks by absolute source offset across freezes', () => {
    const doc = 'aaa\n\nbbb\n\nccc\n\nddd\n\neee'
    const parser = new IncrementalMarkdownParser(parseGfm)
    const grown = parser.update(doc)
    const oneShotKeys = parseGfm(doc).children.map(node => node.position?.start.offset)
    expect([...grown.frozen, ...grown.tail].map(b => b.key)).toEqual(oneShotKeys)
  })

  it('never freezes under a grammar that omits positions', () => {
    const bare = (text: string): Root => {
      const root = parseGfm(text)
      const strip = (nodes: RootContent[]): void => {
        for (const node of nodes) {
          delete node.position
          if ('children' in node) strip(node.children)
        }
      }
      strip(root.children)
      return root
    }
    const parser = new IncrementalMarkdownParser(bare)
    const result = parser.update('a\n\nb\n\nc\n\nd\n\ne')
    expect(result.frozen).toHaveLength(0)
    expect(result.tail).toHaveLength(5)
    // Fallback keys stay unique per sibling.
    expect(new Set(result.tail.map(b => b.key)).size).toBe(5)
  })
})
