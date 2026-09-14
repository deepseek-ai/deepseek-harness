// @vitest-environment jsdom
/** Accumulated document rendering through the real streaming CodeBlock. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { CodeBody } from '../src/client/code/CodeBody.tsx'
import type { CodeBodyProps } from '../src/client/code/CodeBody.tsx'
import type { DocumentContent } from '../src/client/document/contract.ts'
import { en, zh } from '../src/client/code/locales.ts'
import css from '../src/client/code/CodeBody.module.css'
import primitiveCss from '../../ui-primitives/src/markdown/CodeBlock.module.css'

const SESSION = 'code-preview' as SessionId
let stylesheet: HTMLStyleElement | undefined

afterEach(() => {
  try {
    cleanup()
  } finally {
    stylesheet?.remove()
    stylesheet = undefined
  }
})

function contents(pages: readonly string[], eof = false): DocumentContent {
  let offset = 1
  return {
    kind: 'text', text: pages.join('\n'), eof,
    pages: pages.map((text) => {
      const page = { offset, text, lines: text.split('\n').length }
      offset += page.lines
      return page
    }),
  }
}

/** Unused framework seats are omitted; this renderer reads only owner data and t. */
function props(content: DocumentContent, overrides: Partial<CodeBodyProps> = {}): CodeBodyProps {
  return {
    resourceAddress: sessionFileAddress(SESSION, 'source.ts'), sessionId: SESSION,
    content, wrap: false, t: (key: keyof typeof en) => en[key], ...overrides,
  } as CodeBodyProps
}

function element(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector)
  if (found === null) throw new Error(`missing ${selector}`)
  return found
}

function tokens(root: HTMLElement) {
  return [...root.querySelectorAll('.shiki .line')].map(line =>
    [...line.querySelectorAll<HTMLElement>('span[style]')].map(span => [span.textContent, span.style.color]))
}

/** Apply both source stylesheets using Vite's module names; jsdom has no CSS loader. */
function installStyles(): void {
  const directory = dirname(fileURLToPath(import.meta.url))
  const own = readFileSync(resolve(directory, '../src/client/code/CodeBody.module.css'), 'utf8')
    .replaceAll('.renderer', `.${css.renderer}`).replaceAll('.code', `.${css.code}`)
  const shared = readFileSync(resolve(directory, '../../ui-primitives/src/markdown/CodeBlock.module.css'), 'utf8')
    .replaceAll('.block', `.${primitiveCss.block}`)
    .replaceAll('.content', `.${primitiveCss.content}`)
  stylesheet = document.createElement('style')
  // The shared defaults load last to prove the renderer's selectors override them.
  stylesheet.textContent = `${own}\n${shared}`
  document.head.append(stylesheet)
}

describe('CodeBody', () => {
  it('rejects a malformed file address without starting the highlighter', () => {
    expect(() => CodeBody(props(contents(['plain'], true), { resourceAddress: 'not-a-file-address' }))).toThrow('not a file address')
  })

  it.each([
    [sessionFileAddress(SESSION, 'src/space # question?.TS'), 'typescript'],
    [absoluteFileAddress('C:/project/module.MJS'), 'javascript'],
  ])('selects language from the decoded file address %s', (resourceAddress, language) => {
    const view = render(<CodeBody {...props(contents(['const answer = 42'], true), { resourceAddress })} />)
    expect(view.getByText(language, { exact: true })).toBeTruthy()
    expect(element(view.container, '.shiki').textContent).toBe('const answer = 42')
    expect(view.container.querySelector('[data-line-numbers]')).not.toBeNull()
    expect(view.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('carries multiline grammar state across pages and preserves completed lines through settlement', () => {
    const first = 'const before = 1;\n/* open comment'
    const next = 'still a comment\n*/\nconst after = 2;'
    const view = render(<CodeBody {...props(contents([first]))} />)
    const pre = element(view.container, '.shiki')
    const firstLine = element(pre, '.line')
    const copy = view.getByRole('button', { name: 'Copy' })
    view.rerender(<CodeBody {...props(contents([first, next]))} />)
    expect(view.container.querySelectorAll('.md-code-block')).toHaveLength(1)
    expect(element(view.container, '.shiki')).toBe(pre)
    expect(element(pre, '.line')).toBe(firstLine)
    expect(pre.querySelectorAll('.line')).toHaveLength(5)
    expect(view.container.querySelector('[data-line-numbers]')).not.toBeNull()
    const continuation = pre.querySelectorAll('.line').item(2)
    expect(continuation.textContent).toBe('still a comment')
    expect(element(continuation as HTMLElement, 'span').style.color).toBe('var(--shiki-token-comment)')
    expect(pre.textContent).toBe(`${first}\n${next}`)
    view.rerender(<CodeBody {...props(contents([first, next], true))} />)
    expect(element(view.container, '.shiki')).toBe(pre)
    expect(element(pre, '.line')).toBe(firstLine)
    expect(view.getByRole('button', { name: 'Copy' })).toBe(copy)
    const settled = render(<CodeBody {...props(contents([first, next], true))} />)
    expect(tokens(view.container)).toEqual(tokens(settled.container))
  })

  it('highlights the complete source when the last page also reports eof', () => {
    const first = 'const text = `first'
    const last = 'second`;\nconst count = 2;'
    const view = render(<CodeBody {...props(contents([first]))} />)
    const copy = view.getByRole('button', { name: 'Copy' })
    view.rerender(<CodeBody {...props(contents([first, last], true))} />)
    expect(view.container.querySelectorAll('.md-code-block')).toHaveLength(1)
    expect(view.getByRole('button', { name: 'Copy' })).toBe(copy)
    const settled = render(<CodeBody {...props(contents([first, last], true))} />)
    expect(tokens(view.container)).toEqual(tokens(settled.container))
    expect(element(view.container, '.shiki').textContent).toBe(`${first}\n${last}`)
  })

  it('picks up a lazily loaded grammar without losing the source text', async () => {
    const code = 'def answer():\n    return 42'
    const view = render(<CodeBody {...props(contents([code], true), { resourceAddress: sessionFileAddress(SESSION, 'answer.py') })} />)
    expect(element(view.container, 'pre').textContent).toBe(code)
    await waitFor(() => { expect(view.container.querySelector('.shiki')).not.toBeNull() })
    expect(element(view.container, '.shiki').textContent).toBe(code)
    expect(view.container.querySelectorAll('.shiki span[style]').length).toBeGreaterThan(1)
  })

  it.each([['html', '<h1>Source only</h1>'], ['md', '# Source only']])('renders %s as selectable source, not document markup', async (extension, code) => {
    const view = render(<CodeBody {...props(contents([code], true), { resourceAddress: sessionFileAddress(SESSION, `page.${extension}`) })} />)
    await waitFor(() => { expect(view.container.querySelector('.shiki')).not.toBeNull() })
    expect(element(view.container, '.shiki').textContent).toBe(code)
    expect(view.container.querySelector('h1')).toBeNull()
  })

  it('passes localized controls and ignores byte contents outside its loading mode', () => {
    const view = render(<CodeBody {...props(contents(['const a = 1'], true), { t: key => zh[key as keyof typeof zh] })} />)
    expect(view.getByRole('button', { name: '复制' })).toBeTruthy()
    view.rerender(<CodeBody {...props({ kind: 'bytes', data: new TextEncoder().encode('a') })} />)
    expect(view.container.querySelector('.md-code-block')).toBeNull()
  })

  it('keeps a stable inner scrollport while switching wrapping without remounting the highlighter', () => {
    installStyles()
    const code = `const identifier = "${'x'.repeat(300)}";`
    const content = contents([code])
    const view = render(<CodeBody {...props(content)} />)
    const pre = element(view.container, '.shiki')
    const block = element(view.container, '.md-code-block')
    const scrollport = element(view.container, '[data-code-block-content]')
    expect(getComputedStyle(block).marginTop).toBe('0px')
    expect(getComputedStyle(block).position).toBe('static')
    expect(getComputedStyle(element(view.container, '[data-code-preview]')).height).toBe('100%')
    expect(getComputedStyle(scrollport).display).toBe('block')
    expect(getComputedStyle(scrollport).overflow).toBe('auto')
    expect(getComputedStyle(pre).whiteSpace).toBe('pre')
    expect(getComputedStyle(pre).overflow).toBe('visible')
    expect(getComputedStyle(pre).wordBreak).toBe('normal')
    view.rerender(<CodeBody {...props(content, { wrap: true })} />)
    expect(element(view.container, '.shiki')).toBe(pre)
    expect(element(view.container, '[data-code-block-content]')).toBe(scrollport)
    expect(getComputedStyle(pre).whiteSpace).toBe('pre-wrap')
    expect(getComputedStyle(pre).overflowWrap).toBe('anywhere')
    expect(getComputedStyle(pre).overflow).toBe('visible')
    expect(pre.textContent).toBe(code)
    view.rerender(<CodeBody {...props(content)} />)
    expect(getComputedStyle(pre).whiteSpace).toBe('pre')
    expect(getComputedStyle(pre).overflowWrap).toBe('normal')
  })
})
