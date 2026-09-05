// @vitest-environment jsdom
// The fixture corpus is a DOM compatibility baseline; review diffs as
// user-visible Markdown changes rather than regenerating them for refactors.
// One intentional divergence from the original react-markdown recording:
// streaming fences highlight (with their banner language visible) since the
// incremental fence-highlight decision, so `*.streaming.txt` fixtures with
// fenced code pin shiki span trees where react-markdown had the plain arm.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

/**
 * Serialize rendered DOM deterministically: adjacent text nodes coalesced
 * (React renders adjacent string children as separate DOM text nodes while
 * hast merges them — invisible either way), whitespace-only runs dropped
 * outside `pre` (the markdown pipeline injects cosmetic newlines between
 * blocks that HTML rendering collapses), attributes sorted by name, children
 * indented for reviewable diffs.
 */
function serialize(node: Node, indent: string, inPre: boolean): string {
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as Element
  const attrs = [...element.attributes]
    .map(attr => `${attr.name}=${JSON.stringify(attr.value)}`)
    .sort()
    .join(' ')
  const open = attrs === '' ? element.tagName.toLowerCase() : `${element.tagName.toLowerCase()} ${attrs}`
  const nowInPre = inPre || element.tagName === 'PRE'
  return `${indent}<${open}>\n${serializeChildren(element, `${indent}  `, nowInPre)}`
}

function serializeChildren(element: Element, indent: string, inPre: boolean): string {
  let out = ''
  let textRun = ''
  const flush = (): void => {
    if (textRun !== '' && (inPre || textRun.trim() !== '')) {
      out += `${indent}#text ${JSON.stringify(textRun)}\n`
    }
    textRun = ''
  }
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      textRun += child.textContent ?? ''
      continue
    }
    flush()
    out += serialize(child, indent, inPre)
  }
  flush()
  return out
}

function renderCase(text: string, streaming: boolean): string {
  const { container, unmount } = render(<MarkdownText text={text} streaming={streaming} />)
  const out = [...container.childNodes].map(child => serialize(child, '', false)).join('')
  unmount()
  return out
}

const CORPUS: Record<string, string> = {
  'headings-and-paragraphs': [
    '# H1 with `code`',
    '',
    '## H2',
    '',
    '### H3',
    '',
    '#### H4',
    '',
    '##### H5',
    '',
    '###### H6',
    '',
    'Paragraph one with **strong**, *emphasis*, ~~strike~~, and `inline`.',
    '',
    'Setext title',
    '=========',
    '',
    'Second setext',
    '---------',
  ].join('\n'),
  'heading-tight-against-list': '#### Small heading\n\n- one\n- two\n\n##### Next\n\n1. a\n2. b',
  'hard-breaks-and-hr': 'two-space break  \nafter break\n\nbackslash break\\\nafter backslash\n\n---\n\ntail',
  'blockquote-nested': '> level one\n> still one\n>\n> > nested\n>\n> - quoted list\n\nafter',
  'lists-tight-loose-nested': [
    '- tight one',
    '- tight two',
    '  - child',
    '',
    '1. first',
    '2. second',
    '',
    '3. ordered with start',
    '4. next',
    '',
    '- loose item one',
    '',
    '- loose item two',
    '',
    '  second paragraph of loose item',
    '',
    '- item with nested blocks',
    '',
    '  ```',
    '  fenced inside list',
    '  ```',
  ].join('\n'),
  'task-lists': '- [x] done with **strong**\n- [ ] pending\n- plain sibling\n\n1. [x] ordered done\n2. [ ] ordered pending',
  'table-with-alignment': [
    '| Left | Center | Right | None |',
    '| :--- | :---: | ---: | --- |',
    '| a | b | c | `code` |',
    '| [link](https://example.com) | *em* | 1 | 2 |',
  ].join('\n'),
  'code-fences': [
    '```ts',
    'const answer: number = 42',
    '```',
    '',
    '```',
    'no language',
    '```',
    '',
    '```unknown-lang',
    'plain fallback',
    '```',
    '',
    '```ts some=meta',
    'const withMeta = true',
    '```',
    '',
    '```',
    '```',
    '',
    '    indented code block',
    '    second line',
  ].join('\n'),
  'fence-trailing-blank-lines': [
    '```',
    'kept blank line follows',
    '',
    '```',
    '',
    '```ts',
    'const doubled = true',
    '',
    '',
    '```',
    '',
    'after',
  ].join('\n'),
  'table-header-only': '| a | b |\n| --- | --- |\n\nafter',
  // Four columns take the md-table-wide hook at top level; the same table
  // inside a blockquote falls back to the fill arm.
  'table-wide-and-blockquote': [
    '| C1 | C2 | C3 | C4 |',
    '| --- | --- | --- | --- |',
    '| a | b | c | d |',
    '',
    '> | Q1 | Q2 | Q3 | Q4 |',
    '> | --- | --- | --- | --- |',
    '> | a | b | c | d |',
  ].join('\n'),
  'inline-code-with-newline': 'Spans `a\nb` across a line.',
  'links-and-autolinks': [
    '[https ok](https://example.com "with title") and [mailto ok](mailto:dev@example.com).',
    '',
    '[relative dropped](/settings) and [js dropped](javascript:alert(1)) and [upper kept](HTTPS://example.com).',
    '',
    '<https://deepseek.com> and bare autolink https://autolink.example.com literal.',
    '',
    '[spaces encoded](https://example.com/a b)',
    '',
    '[![linked badge](https://example.com/badge.png)](https://example.com/target) image-only anchors carry no leading glyph.',
  ].join('\n'),
  'images': [
    '![https image](https://example.com/secure.png "img title")',
    '',
    '![http image](http://example.com/plain.png)',
    '',
    '![relative dropped](private.png) and inline ![bad scheme](javascript:alert(1)) end.',
    '',
    '![](https://example.com/empty-alt.png)',
  ].join('\n'),
  'reference-links-and-images': [
    'A [full][ref] reference, a [collapsed][] one, and a [shortcut] one.',
    '',
    '[missing full][nope], [missing collapsed][], ![missing image][gone].',
    '',
    '![ref image][imgref]',
    '',
    '[ref]: https://example.com/ref "ref title"',
    '[collapsed]: https://example.com/collapsed',
    '[shortcut]: https://example.com/shortcut',
    '[imgref]: https://example.com/ref.png',
  ].join('\n'),
  'footnotes': [
    'First use[^a] and reuse[^a] and another[^b].',
    '',
    '[^a]: Footnote a body with [link](https://example.com).',
    '',
    '[^b]: Footnote b first paragraph.',
    '',
    '    Second paragraph of b.',
  ].join('\n'),
  'raw-html-dropped': [
    '<script>globalThis.compromised = true</script>',
    '',
    'Paragraph with inline <img src="x" onerror="boom"> html and <b>bold tag</b> kept literal?',
    '',
    '<div class="x">',
    'html block content',
    '</div>',
    '',
    'after',
  ].join('\n'),
  'entities-and-escapes': 'AT&amp;T, 3 &lt; 4, \\*not em\\*, backslash \\\\ literal, &copy; entity.',
  'math-inline-and-display': [
    'Einstein wrote $E = mc^2$ inline.',
    '',
    '$$',
    '\\frac{\\partial \\mathbf{u}}{\\partial t} + (\\mathbf{u} \\cdot \\nabla)\\mathbf{u} = -\\frac{1}{\\rho}\\nabla p',
    '$$',
    '',
    'Backslash inline \\(\\frac{1}{5}\\) and display:',
    '',
    '\\[\\frac{\\pi}{4} < \\theta < \\frac{\\pi}{2}\\]',
  ].join('\n'),
  'math-edge-cases': [
    'Trusted commands stay off: $\\href{javascript:alert(1)}{unsafe}$.',
    '',
    'Unbalanced errors render the error arm: $\\frac{$',
    '',
    '| Symbol | Value |',
    '| --- | --- |',
    '| $\\theta$ | \\(\\frac{1}{5}\\) |',
    '',
    '```math',
    '\\sqrt{2}',
    '```',
  ].join('\n'),
  'gfm-strikethrough-and-literals': 'Mixed ~~gone~~ text with www.example.com literal and user@example.com email.',
  'cjk-strong-and-inline-code-url': [
    '**注意：**内容在标点后直接闭合。',
    '',
    '**Notice:**text keeps upstream parsing.',
    '',
    '*提醒！*单星号也保持上游行为。',
    '',
    '`https://example.com/preview?q=one%20two#result` 与 `curl http://127.0.0.1:3199/` 以及 `javascript:alert(1)`。',
  ].join('\n'),
  'definition-only': '[unused]: https://example.com/unused',
  'streaming-typical-partial': '## Streaming\n\n- first\n- **unfinished',
}

describe('MarkdownText DOM parity fixtures', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    it(`settled: ${name}`, async () => {
      await expect(renderCase(text, false)).toMatchFileSnapshot(`./fixtures/markdown-dom/${name}.settled.txt`)
    })
    it(`streaming: ${name}`, async () => {
      await expect(renderCase(text, true)).toMatchFileSnapshot(`./fixtures/markdown-dom/${name}.streaming.txt`)
    })
  }
})
