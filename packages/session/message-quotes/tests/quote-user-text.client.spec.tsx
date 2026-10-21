// @vitest-environment jsdom
/** Quote display consumes decoded text without evaluating its contents. */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { formatQuoteText } from '@deepseek-ai/dsh-client-ui-primitives'
import { UserTextRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts'
import type { UserTextFacts } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { quoteRule } from '../src/client/quote-rule.ts'
import { createUserTextFixture } from '../../../client/ui-conversation/tests/user-text-component-fixture.client.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('quote UserText', () => {
  it('keeps ordinary text masking and reference decoration outside quotes', () => {
    const secret = 'sk-1234567890abcdefghijklmnopqrstuvwxyz'
    const excerpt = `${secret} @inside.md /review **literal**`
    const renderText = createUserTextFixture()
    const view = render(<>{renderText({
      text: `${secret} @outside.md\n\n${formatQuoteText(excerpt)}`,
      facts: { skillNames: ['review'] },
    })}</>)
    expect(view.container.querySelectorAll('[data-secret]')).toHaveLength(1)
    expect(view.container.querySelector('[data-ref-chip]')?.textContent).toBe('outside.md')
    expect(view.container.querySelector('[data-quote-preview-text]')?.textContent).toBe(excerpt)
    expect(view.container.querySelector('[data-quote-preview] [data-secret], [data-quote-preview] [data-ref-chip]')).toBeNull()
  })

  it('renders typed blockquotes without metadata and leaves their references literal', () => {
    const text = 'before\n\n> @file.ts /review\n\nafter'
    const renderText = createUserTextFixture()
    const view = render(<>{renderText({ text, facts: { skillNames: ['review'] } })}</>)
    expect(view.container.querySelector('[data-quote-preview-text]')?.textContent).toBe('@file.ts /review')
    expect(view.container.querySelector('[data-ref-chip]')).toBeNull()
    expect(view.container.textContent).toBe('before @file.ts /review after')
  })

  it('keeps nested quote markers literal in the excerpt', () => {
    const renderText = createUserTextFixture()
    const view = render(<>{renderText({ text: '> > nested', facts: {} })}</>)
    expect(view.container.querySelectorAll('[data-quote-preview]')).toHaveLength(1)
    expect(view.container.querySelector('[data-quote-preview-text]')?.textContent).toBe('> nested')
  })

  it('keeps recognized Session labels in the same plain text as the rest of the quote', () => {
    const renderText = createUserTextFixture()
    const excerpt = 'before @Quote source after'
    const view = render(<>{renderText({
      text: `@Quote source\n\n${formatQuoteText(excerpt)}`,
      facts: { sessionLabels: ['Quote source'] },
    })}</>)
    expect(view.container.querySelectorAll('[data-ref-chip]')).toHaveLength(1)
    const quotedText = view.container.querySelector('[data-quote-preview-text]')!
    expect(quotedText.textContent).toBe(excerpt)
    expect(quotedText.childElementCount).toBe(0)
  })

  it('preserves credential spelling and reference syntax in the excerpt and full-text card', async () => {
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(200)
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    const secret = 'sk-1234567890abcdefghijklmnopqrstuvwxyz'
    const text = formatQuoteText(`${secret} @notes.md /review`)
    const renderText = createUserTextFixture()
    const view = render(<>{renderText({ text, facts: {}, interactive: true })}</>)
    expect(view.container.querySelector('[data-quote-preview-text]')?.textContent).toBe(`${secret} @notes.md /review`)
    expect(view.container.querySelector('[data-secret]')).toBeNull()
    expect(view.container.querySelector('[data-ref-chip]')).toBeNull()
    expect(view.container.querySelector('button')).toBeNull()
    fireEvent.pointerEnter(view.container.querySelector('[data-quote-preview]')!)
    await waitFor(() => {
      expect(document.querySelector('[data-quote-popover]')?.textContent).toBe(`${secret} @notes.md /review`)
      expect(document.querySelector('[data-quote-popover] [data-secret]')).toBeNull()
    })
    scrollWidth.mockRestore()
    clientWidth.mockRestore()
  })

  it('retains parsed quote nodes across unchanged evaluations', async () => {
    const ctx = new Context()
    try {
      const registry = new UserTextRegistry(ctx)
      registry.register(quoteRule)
      const evaluate = registry.createEvaluator()
      const text = 'before\n\n> quote\n\nafter'
      const initial = evaluate({ text, facts: {} })
      expect(initial.find(node => node.id === 'quote')).toMatchObject({ start: 8, end: 15, data: { text: 'quote' } })
      expect(evaluate({ text, facts: {} })).toBe(initial)
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves source offsets while displaying consecutive quote blocks and their separators', async () => {
    const ctx = new Context()
    try {
      const registry = new UserTextRegistry(ctx)
      registry.register(quoteRule)
      const content = [
        { type: 'text', text: 'before\n\n' },
        { type: 'text', text: '> first\n> line' },
        { type: 'text', text: '\n\n' },
        { type: 'text', text: '> second' },
        { type: 'text', text: '\n\nafter' },
      ]
      const text = content.map(block => block.text).join('')
      const nodes = registry.createEvaluator()({ text, facts: {} })
      expect(nodes.filter(node => node.id === 'quote')).toEqual([
        { id: 'quote', start: 8, end: 22, data: { text: 'first\nline' } },
        { id: 'quote', start: 24, end: 32, data: { text: 'second' } },
      ])
      expect(nodes.filter(node => node.id === 'text' && node.data.display === ' ')).toEqual([
        { id: 'text', start: 6, end: 8, data: { text: '\n\n', display: ' ' } },
        { id: 'text', start: 22, end: 24, data: { text: '\n\n', display: ' ' } },
        { id: 'text', start: 32, end: 34, data: { text: '\n\n', display: ' ' } },
      ])
      expect(nodes.map(node => text.slice(node.start, node.end)).join('')).toBe(text)
      const facts: Readonly<Partial<UserTextFacts>> = {}
      const context = { read: <Key extends keyof UserTextFacts>(key: Key) => facts[key] }
      expect(quoteRule.match(text, 10, context)).toMatchObject({ id: 'text', start: 22, end: 24 })
      expect(quoteRule.match(text, 23, context)).toMatchObject({ id: 'quote', start: 24, end: 32 })
      expect(quoteRule.match(text, 34, context)).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})
