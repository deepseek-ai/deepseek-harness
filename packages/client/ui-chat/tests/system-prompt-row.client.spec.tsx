// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { SystemPromptNodeView } from '../src/client/chat/SystemPromptRow.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

describe('SystemPromptNodeView', () => {
  it('mounts the opaque context body only while its row is expanded', () => {
    const text = '# Agent rules\n\n- Read first\n- **Act carefully**'
    const node: ChatNode<'system-prompt'> = {
      key: 'request-prompt:1',
      kind: 'system-prompt',
      id: '1',
      target: 'chat',
      anchorSeq: 1,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: { text },
    }
    const { container } = render(<SystemPromptNodeView
      node={node}
      t={makeTranslate(en)}
    />)

    const disclosure = screen.getByRole('button', { name: 'System prompt' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-system-prompt-body]')).toBeNull()
    expect(container.querySelector('[data-context-text]')).toBeNull()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-system-prompt-body]')).not.toBeNull()
    expect(container.querySelector('[data-context-text]')?.textContent).toBe(text)
    expect(screen.queryByRole('heading', { name: 'Agent rules' })).toBeNull()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-system-prompt-body]')).toBeNull()
  })

  it('titles an in-history prompt update as an update of the same row', () => {
    const node: ChatNode<'system-prompt'> = {
      key: 'system-message:10',
      kind: 'system-prompt',
      id: '10',
      target: 'chat',
      anchorSeq: 10,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: { text: '# Updated rules', update: true },
    }
    const { container } = render(<SystemPromptNodeView node={node} t={makeTranslate(en)} />)

    const disclosure = screen.getByRole('button', { name: 'System prompt update' })
    fireEvent.click(disclosure)
    expect(container.querySelector('[data-context-text]')?.textContent).toBe('# Updated rules')
    expect(container.querySelector('[data-system-sources]')).toBeNull()
  })

  it('names the sources of a section-attributed update and splits its body by source', () => {
    const update = (changes: readonly { name: string; change: 'updated' | 'removed' | 'added'; text: string; notices: readonly string[] }[], reset = false) => {
      const node: ChatNode<'system-prompt'> = {
        key: 'system-message:10', kind: 'system-prompt', id: '10', target: 'chat', anchorSeq: 10,
        location: { kind: 'unresolved' }, visibility: 'visible',
        data: { text: 'joined', update: true, message: { reset, notices: reset ? ['Earlier guidance is superseded.'] : [], changes } },
      }
      return render(<SystemPromptNodeView node={node} t={makeTranslate(en)} />)
    }
    const two = update([
      { name: 'plan:status', change: 'updated', text: 'Plan mode is off.', notices: ['The plan status changed.'] },
      { name: 'tool:bash', change: 'removed', text: '', notices: [] },
    ])
    expect(two.container.querySelector('[data-system-sources]')?.textContent).toBe('plan:status, tool:bash')
    fireEvent.click(screen.getByRole('button', { name: /System prompt update/ }))
    expect(two.container.querySelector('[data-system-sources]')).not.toBeNull()
    expect(two.container.querySelector('[data-context-text]')).toBeNull()
    expect(two.container.querySelector('[data-system-reset]')).toBeNull()
    expect([...two.container.querySelectorAll('[data-system-section]')].map(section => [
      section.getAttribute('data-system-section'), ...[...section.children].map(child => child.textContent),
    ])).toEqual([
      ['updated', 'Updated plan:status', 'The plan status changed.', 'Plan mode is off.'],
      ['removed', 'Removed tool:bash'],
    ])
    cleanup()

    const many = update([
      { name: 'a', change: 'added', text: 'A', notices: [] },
      { name: 'b', change: 'added', text: 'B', notices: [] },
      { name: 'c', change: 'added', text: 'C', notices: [] },
    ], true)
    expect(many.container.querySelector('[data-system-sources]')?.textContent).toBe('3 sections')
    fireEvent.click(screen.getByRole('button', { name: /System prompt update/ }))
    expect(many.container.querySelector('[data-system-reset]')?.textContent).toBe('Replaces all earlier instructions')
    expect([...many.container.querySelectorAll('p[data-system-notice]')].map(notice => notice.textContent))
      .toEqual(['Earlier guidance is superseded.'])
  })
})
