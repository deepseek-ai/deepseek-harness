// @vitest-environment jsdom
// The streaming fence arm: StreamingHighlightSession's incremental
// tokenization equals from-scratch tokenization at every appended prefix, and
// CodeBlock's `streaming` arm renders the same token tree as the settled
// shiki-HTML swap while keeping completed lines' DOM nodes untouched. Lives
// apart from code-block.client.spec.tsx so its lazy-grammar timing cannot
// race that file's first-touch assertions (files run isolated).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { StreamingHighlightSession } from '../src/markdown/highlight.ts'
import { markdownLabels } from './labels.client.ts'

const LABELS = markdownLabels.code

afterEach(cleanup)

/**
 * One arm's rendered token tree, with every style channel the settled shiki
 * HTML emits (color plus the markup font-style bits), so equality between the
 * streaming spans and the settled `codeToHtml` swap pins full visual parity.
 */
function readPre(root: HTMLElement) {
  const pre = root.querySelector('pre.shiki')
  expect(pre).not.toBeNull()
  return {
    classes: [...pre!.classList].sort().join(' '),
    tabIndex: pre!.getAttribute('tabindex'),
    text: pre!.textContent,
    lines: [...pre!.querySelectorAll('.line')].map(line =>
      [...line.querySelectorAll('span[style]')].map((span) => {
        const style = (span as HTMLElement).style
        return `${span.textContent ?? ''}|${style.color}|${style.fontStyle}|${style.fontWeight}|${style.textDecoration}`
      }),
    ),
  }
}

describe('StreamingHighlightSession', () => {
  it('reconstructs the code verbatim and colors tokens through --shiki-* properties', () => {
    const code = 'const a = 1\n// note\nconst b = "x"'
    const lines = new StreamingHighlightSession().update(code, 'ts')
    expect(lines?.map(line => line.map(span => span.text).join('')).join('\n')).toBe(code)
    expect(lines?.[0]?.[0]).toEqual({ text: 'const', style: { color: 'var(--shiki-token-keyword)' } })
    expect(lines?.[1]?.[0]?.style.color).toBe('var(--shiki-token-comment)')
  })

  it('incremental growth equals a fresh from-scratch tokenization at every prefix', () => {
    // The template literal spans lines, so mid-stream states leave the
    // grammar inside a multi-line construct — the case where a stale saved
    // state would color the continuation wrong.
    const code = 'const s = `template\nline ${x} mid\n` // done\nconst t: number = 42'
    const session = new StreamingHighlightSession()
    for (let end = 1; end <= code.length; end++) {
      const slice = code.slice(0, end)
      expect(session.update(slice, 'ts')).toEqual(new StreamingHighlightSession().update(slice, 'ts'))
    }
  })

  it('keeps completed lines\' span arrays identical across growth and re-tokenizes only the tail', () => {
    const session = new StreamingHighlightSession()
    const first = session.update('const a = 1\nlet', 'ts')
    expect(first).toBeDefined()
    const second = session.update('const a = 1\nlet b = 2', 'ts')
    expect(second?.[0]).toBe(first?.[0])
    expect(second?.[1]).not.toBe(first?.[1])
  })

  it('reports only newly completed lines to a retained renderer', () => {
    const session = new StreamingHighlightSession()
    const first = session.updateFrame('const a = 1\nlet', 'ts')
    const second = session.updateFrame('const a = 1\nlet b = 2\n// tail', 'ts')
    expect(first?.appended).toHaveLength(1)
    expect(first?.tail).toHaveLength(1)
    expect(second?.appended).toHaveLength(1)
    expect(second?.appended[0]?.map(span => span.text).join('')).toBe('let b = 2')
    expect(second?.tail[0]?.map(span => span.text).join('')).toBe('// tail')
    expect(second?.generation).toBe(first?.generation)
    expect(session.updateFrame('const a = 1\nlet b = 2\n// tail', 'ts')).toBe(second)
  })

  it('emits one completed line per frame across an 800-line stream', () => {
    const session = new StreamingHighlightSession()
    let code = ''
    let generation: number | undefined
    let appended = 0
    for (let index = 0; index < 800; index += 1) {
      const line = `const value${String(index)} = ${String(index)}`
      code += `${line}\n`
      const frame = session.updateFrame(code, 'ts')
      expect(frame?.appended).toHaveLength(1)
      expect(frame?.appended[0]?.map(span => span.text).join('')).toBe(line)
      generation ??= frame?.generation
      expect(frame?.generation).toBe(generation)
      appended += frame?.appended.length ?? 0
    }
    // Frame cardinality is stable across CI hosts; wall-clock thresholds are
    // diagnostics owned by the manual Web performance inventory.
    expect(appended).toBe(800)
  })

  it('is idempotent per input: repeated calls return the identical result array', () => {
    const session = new StreamingHighlightSession()
    const result = session.update('const a = 1', 'ts')
    expect(result).toBeDefined()
    expect(session.update('const a = 1', 'ts')).toBe(result)
  })

  it('an alias switch onto the same grammar keeps the cache; a different grammar re-tokenizes correctly', () => {
    const session = new StreamingHighlightSession()
    const first = session.update('const a = 1\nlet', 'ts')
    expect(first).toBeDefined()
    // Same code under a different alias of the same grammar: recomputed
    // (the idempotence key is the raw input) but the line cache is kept.
    const aliased = session.update('const a = 1\nlet', 'typescript')
    expect(aliased?.[0]).toBe(first?.[0])
    const json = session.update('{"a": 1}', 'json')
    expect(json).toEqual(new StreamingHighlightSession().update('{"a": 1}', 'json'))
  })

  it('non-append input re-tokenizes from scratch', () => {
    const session = new StreamingHighlightSession()
    session.update('const a = 1\nconst b = 2', 'ts')
    const replaced = session.update('let c = 3', 'ts')
    expect(replaced).toEqual(new StreamingHighlightSession().update('let c = 3', 'ts'))
  })

  it('returns undefined for unknown or absent languages, then recovers when a known one arrives', () => {
    const session = new StreamingHighlightSession()
    expect(session.update('x', 'cobol')).toBeUndefined()
    expect(session.update('x', undefined)).toBeUndefined()
    expect(session.update('const x = 1', 'ts')).toEqual(new StreamingHighlightSession().update('const x = 1', 'ts'))
  })

  it('a lazy grammar reports plain until it registers, then highlights on the next update', async () => {
    const session = new StreamingHighlightSession()
    expect(session.update('print(1)', 'python')).toBeUndefined()
    await vi.waitFor(() => {
      const lines = session.update('print(1)', 'python')
      expect(lines?.[0]?.map(span => span.text).join('')).toBe('print(1)')
      expect(lines?.[0]?.length).toBeGreaterThan(1)
    }, { timeout: 5_000 })
  })

  it('a trailing newline renders as a real empty last line (settled-arm parity)', () => {
    const lines = new StreamingHighlightSession().update('const a = 1\n', 'ts')
    expect(lines).toHaveLength(2)
    expect(lines?.[1]).toEqual([])
  })

  it('a blank line inside a multi-line construct keeps the saved grammar state', () => {
    // The empty completed segment tokenizes as [[]]; the state saved after it
    // must still be the inside-template state, so the continuation stays
    // string-colored (incremental equals from-scratch at every prefix).
    const code = 'const s = `a\n\nb` // done'
    const session = new StreamingHighlightSession()
    for (let end = 1; end <= code.length; end++) {
      const slice = code.slice(0, end)
      expect(session.update(slice, 'ts')).toEqual(new StreamingHighlightSession().update(slice, 'ts'))
    }
    const lines = session.update(code, 'ts')
    expect(lines?.[1]).toEqual([])
    expect(lines?.[2]?.[0]?.text).toBe('b`')
    expect(lines?.[2]?.[0]?.style.color).toBe('var(--shiki-token-string-expression)')
  })

  it('a CRLF boundary never leaks its \\r into the grammar (shiki line-split parity)', () => {
    // bash: a backslash continuation only holds if the line ends at the
    // continuation — a leaked \r would break the saved state and recolor the
    // next line as a fresh command.
    const code = 'echo a \\\r\nb\r\nc'
    const session = new StreamingHighlightSession()
    for (let end = 1; end <= code.length; end++) {
      const slice = code.slice(0, end)
      expect(session.update(slice, 'bash')).toEqual(new StreamingHighlightSession().update(slice, 'bash'))
    }
    // Span text carries no \r for completed lines, exactly like the settled
    // arm's shiki output.
    const lines = session.update(code, 'bash')
    expect(lines?.map(line => line.map(span => span.text).join('')).join('\n')).toBe('echo a \\\nb\nc')
  })

  it('markdown markup styles (bold/italic/underline) reach the spans once the grammar loads', async () => {
    const snippet = '# Heading\n**bold words** and *italic* and a [link with spaces](https://x.example) tail'
    await vi.waitFor(() => {
      expect(new StreamingHighlightSession().update('# x', 'md')).toBeDefined()
    }, { timeout: 5_000 })
    const session = new StreamingHighlightSession()
    for (let end = 1; end <= snippet.length; end++) {
      const slice = snippet.slice(0, end)
      expect(session.update(slice, 'md')).toEqual(new StreamingHighlightSession().update(slice, 'md'))
    }
    const lines = session.update(snippet, 'md')
    expect(lines?.[0]?.[0]?.style.fontWeight).toBe('bold')
    const spans = lines?.[1] ?? []
    expect(spans.some(span => span.style.fontWeight === 'bold')).toBe(true)
    expect(spans.some(span => span.style.fontStyle === 'italic')).toBe(true)
    expect(spans.some(span => span.style.textDecoration === 'underline')).toBe(true)
  })
})

describe('CodeBlock streaming arm', () => {
  it('renders the same token tree as the settled shiki HTML swap', () => {
    const code = 'const s = `tpl\nline ${x}\n`\n'
    const streamed = render(<CodeBlock code={code} lang="ts" streaming {...LABELS} />)
    const settled = render(<CodeBlock code={code} lang="ts" {...LABELS} />)
    expect(readPre(streamed.container)).toEqual(readPre(settled.container))
  })

  it('a markdown fence matches the settled swap including font styles, and a CRLF fence matches too', async () => {
    // md is a lazy grammar: wait for it so both arms highlight.
    await vi.waitFor(() => {
      expect(new StreamingHighlightSession().update('# x', 'md')).toBeDefined()
    }, { timeout: 5_000 })
    const md = '# Heading\n**bold words** and *italic* and a [link with spaces](https://x.example) tail\n'
    const mdStreamed = render(<CodeBlock code={md} lang="md" streaming {...LABELS} />)
    const mdSettled = render(<CodeBlock code={md} lang="md" {...LABELS} />)
    const streamedTree = readPre(mdStreamed.container)
    expect(streamedTree).toEqual(readPre(mdSettled.container))
    // The settled arm really carries the styles, so the equality above cannot
    // pass by both arms dropping them.
    const flat = streamedTree.lines.flat().join(' ')
    expect(flat).toContain('|bold|')
    expect(flat).toContain('|italic|')
    expect(flat).toContain('|underline')
    const crlf = 'echo a \\\r\nb\r\nc\n'
    const crlfStreamed = render(<CodeBlock code={crlf} lang="bash" streaming {...LABELS} />)
    const crlfSettled = render(<CodeBlock code={crlf} lang="bash" {...LABELS} />)
    expect(readPre(crlfStreamed.container)).toEqual(readPre(crlfSettled.container))
  })

  it('keeps completed lines\' DOM nodes as the code grows and appends the new ones', () => {
    const view = render(<CodeBlock code={'const a = 1\nlet partial\n'} lang="ts" streaming {...LABELS} />)
    const firstLine = view.container.querySelector('pre.shiki .line')
    expect(firstLine).not.toBeNull()
    view.rerender(<CodeBlock code={'const a = 1\nlet partial = 2\n// tail\n'} lang="ts" streaming {...LABELS} />)
    const lines = view.container.querySelectorAll('pre.shiki .line')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(firstLine)
    expect(lines[2]?.textContent).toBe('// tail')
    // Newlines separate the line spans, so pre textContent (the copy source)
    // stays the code verbatim.
    expect(view.container.querySelector('pre.shiki')?.textContent).toBe('const a = 1\nlet partial = 2\n// tail')
  })

  it('keeps a tail line mounted when the next frame completes it', () => {
    const view = render(<CodeBlock code={'const first = 1\n'} lang="ts" streaming {...LABELS} />)
    const firstLine = view.container.querySelector('pre.shiki .line')
    expect(firstLine).not.toBeNull()
    view.rerender(
      <CodeBlock code={'const first = 1\nconst second = 2\nlet tail'} lang="ts" streaming {...LABELS} />,
    )
    expect(view.container.querySelector('pre.shiki .line')).toBe(firstLine)
  })

  it('keeps completed line groups mounted while later groups grow', () => {
    const code = (count: number) => Array.from({ length: count }, (_, index) => `const v${String(index)} = ${String(index)}`).join('\n')
    const view = render(<CodeBlock code={code(40)} lang="ts" streaming {...LABELS} />)
    const firstLine = view.container.querySelector('pre.shiki .line')
    const thirtySecond = view.container.querySelectorAll('pre.shiki .line')[31]
    view.rerender(<CodeBlock code={code(80)} lang="ts" streaming {...LABELS} />)
    const lines = view.container.querySelectorAll('pre.shiki .line')
    expect(lines).toHaveLength(80)
    expect(lines[0]).toBe(firstLine)
    expect(lines[31]).toBe(thirtySecond)
  })

  it('reuses an unchanged frame when an unrelated lazy grammar finishes loading', async () => {
    const view = render(<CodeBlock code={'const stable = 1\n'} lang="ts" streaming {...LABELS} />)
    const line = view.container.querySelector('pre.shiki .line')
    expect(line).not.toBeNull()
    const loader = new StreamingHighlightSession()
    expect(loader.update('puts 1', 'ruby')).toBeUndefined()
    await vi.waitFor(() => { expect(loader.update('puts 1', 'ruby')).toBeDefined() }, { timeout: 5_000 })
    expect(view.container.querySelector('pre.shiki .line')).toBe(line)
  })

  it('streaming with an unknown language stays on the identical plain arm', () => {
    const view = render(<CodeBlock code={'IDENTIFICATION DIVISION.\n'} lang="cobol" streaming {...LABELS} />)
    expect(view.container.querySelector('pre.shiki')).toBeNull()
    expect(view.getByText('IDENTIFICATION DIVISION.')).toBeTruthy()
  })

  it('the settle transition preserves the highlighted DOM when the code is unchanged', () => {
    const code = 'const answer = 42\n'
    const view = render(<CodeBlock code={code} lang="ts" streaming {...LABELS} />)
    const streamedLine = view.container.querySelector('pre.shiki .line')
    const streamedText = view.container.querySelector('pre.shiki')?.textContent
    view.rerender(<CodeBlock code={code} lang="ts" {...LABELS} />)
    const settledText = view.container.querySelector('pre.shiki')?.textContent
    expect(streamedText).toBe('const answer = 42')
    expect(settledText).toBe(streamedText)
    expect(view.container.querySelector('pre.shiki .line')).toBe(streamedLine)
    view.rerender(<CodeBlock code={code} lang="ts" streaming {...LABELS} />)
    expect(view.container.querySelector('pre.shiki')?.textContent).toBe(streamedText)
    expect(view.container.querySelector('pre.shiki .line')).toBe(streamedLine)
  })
})
