// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderReasoningSlot as renderSlot, unusedImageLoader } from './reasoning-component-fixture.tsx'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import type { TranscriptViewMode } from '../src/chat-settings.ts'
import { derivePresentationPolicy, type CollapseTiming, type FoldedReplies } from '../src/client/presentation-policy.ts'
import { ReasoningRow } from '../src/client/chat/ReasoningRow.tsx'
import { bindDisclosure, useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useSearchableHidden } from '../src/client/chat/searchable-hidden.ts'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)

describe('AssistantMarkdown reasoning blocks', () => {
  const props = {
    renderSlot, useDisclosure, useGroupAction: useSearchableHidden,
    usePresentation: useDetailedPresentation, loadImage: unusedImageLoader, t,
  }

  it.each([false, true])('omits blank blocks without trimming body text when streaming=%s', (streaming) => {
    const text = '\n  **Visible reasoning**\n\nOriginal body  \n'
    const texts = ['', ' \t\r\n', text, '']
    const blocks = Object.freeze(texts.map(text => Object.freeze({ kind: 'reasoning' as const, text })))
    const calls = vi.fn()
    const extension: AssistantMarkdownProps['renderSlot'] = (key, owner, options) => {
      calls(key, owner)
      return renderSlot(key, owner, options)
    }
    const view = render(<AssistantMarkdown {...props} renderSlot={extension} blocks={blocks} streaming={streaming} />)
    expect(view.getAllByRole('button')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-variant="think"]')).toHaveLength(1)
    fireEvent.click(view.getByRole('button'))
    expect(calls).toHaveBeenCalledWith('conversation.chat.reasoning.body', { rawText: text, text, running: false })
    expect(view.getByText('Visible reasoning').tagName).toBe('STRONG')
    expect(blocks.map(block => block.text)).toEqual(texts)
  })

  it.each([false, true])('waits for non-whitespace reasoning when streaming=%s', (streaming) => {
    const view = render(<AssistantMarkdown {...props} blocks={[{ kind: 'reasoning', text: '' }]} streaming={streaming} />)
    expect(view.queryAllByRole('button')).toHaveLength(0)
    for (const text of [' ', '\t', '\r\n', ' \t\r\n', '\u00a0']) {
      view.rerender(<AssistantMarkdown {...props} blocks={[{ kind: 'reasoning', text }]} streaming={streaming} />)
      expect(view.queryAllByRole('button')).toHaveLength(0)
    }
    view.rerender(<AssistantMarkdown {...props} blocks={[{ kind: 'reasoning', text: '\n First thought' }]} streaming={streaming} />)
    expect(view.getAllByRole('button')).toHaveLength(1)
  })

  it('retains an expanded earlier row when a blank streaming tail receives text', () => {
    const first = { kind: 'reasoning' as const, text: 'First thought\n\nEarlier body' }
    const blank = { kind: 'reasoning' as const, text: ' \t\r\n' }
    const view = render(<AssistantMarkdown {...props} blocks={[first, blank, blank]} streaming />)
    const earlierToggle = view.getByRole('button')
    const earlierRow = earlierToggle.closest('[data-variant="think"]')
    expect(earlierRow?.getAttribute('data-state')).toBe('ok')
    expect(view.queryByText('运行中')).toBeNull()
    fireEvent.click(earlierToggle)
    const earlierBody = view.getByText('Earlier body')

    const tail = { kind: 'reasoning' as const, text: 'An unfinished tail' }
    const blocks = [first, blank, tail]
    view.rerender(<AssistantMarkdown {...props} blocks={blocks} streaming />)
    const toggles = view.getAllByRole('button')
    expect(toggles).toHaveLength(2)
    expect(toggles[0]).toBe(earlierToggle)
    expect(view.getByText('Earlier body')).toBe(earlierBody)
    expect(earlierToggle.getAttribute('aria-expanded')).toBe('true')
    expect(earlierRow?.getAttribute('data-state')).toBe('ok')
    const tailToggle = toggles[1]!
    const tailRow = tailToggle.closest('[data-variant="think"]')
    expect(tailRow?.getAttribute('data-state')).toBe('running')
    expect(view.queryByText(tail.text)).toBeNull()
    fireEvent.click(tailToggle)
    expect(view.getByText(tail.text)).toBeTruthy()
    expect(earlierToggle.getAttribute('aria-expanded')).toBe('true')

    view.rerender(<AssistantMarkdown {...props} blocks={blocks} streaming={false} />)
    const settledToggles = view.getAllByRole('button')
    expect(settledToggles).toHaveLength(2)
    expect(settledToggles[0]).toBe(earlierToggle)
    expect(settledToggles[1]).toBe(tailToggle)
    expect(view.getByText('Earlier body')).toBe(earlierBody)
    expect(tailRow?.getAttribute('data-state')).toBe('ok')
    expect(tailToggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(tailToggle)
    expect(earlierToggle.getAttribute('aria-expanded')).toBe('true')
    expect(tailToggle.getAttribute('aria-expanded')).toBe('false')
  })

  it.each(['Partial thought', '', ' \t\r\n'])('retains the stopped marker with blank reasoning around %j', (text) => {
    const blocks = ['', text, ' \t\r\n'].map(text => ({ kind: 'reasoning' as const, text }))
    const view = render(<AssistantMarkdown {...props} blocks={blocks} groupPart="reasoning" streaming={false} interrupted />)
    expect(view.queryAllByRole('button')).toHaveLength(text.trim() === '' ? 0 : 1)
    expect(view.getByText(t('message.stopped'))).toBeTruthy()
    expect(view.queryByText('运行中')).toBeNull()
  })

  it('keeps non-blank rows and their expanded bodies across modes, excluding them from the response part', () => {
    const mode = createSnapshotStore<TranscriptViewMode>('compact')
    const usePresentation = bindSnapshotSelector(derivePresentationPolicy(mode, createSnapshotStore<CollapseTiming>('completion'), createSnapshotStore<FoldedReplies>('all')))
    const blocks: AssistantMarkdownProps['blocks'] = [
      { kind: 'reasoning', text: '' },
      { kind: 'reasoning', text: 'Mode thought\n\nMode body' },
      { kind: 'reasoning', text: ' \t\r\n' },
      { kind: 'text', text: 'Answer' },
    ]
    const view = render(<AssistantMarkdown {...props} usePresentation={usePresentation}
      blocks={blocks} groupPart="reasoning" streaming={false} />)
    const toggle = view.getByRole('button')
    fireEvent.click(toggle)
    const body = view.getByText('Mode body')
    for (const next of ['standard', 'detailed', 'verbose', 'compact'] as const) {
      act(() => { mode.set(next) })
      expect(view.getAllByRole('button')).toHaveLength(1)
      expect(view.getByRole('button')).toBe(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(view.getByText('Mode body')).toBe(body)
      expect(view.queryByText('Answer')).toBeNull()
    }
    view.rerender(<AssistantMarkdown {...props} usePresentation={usePresentation}
      blocks={blocks} groupPart="response" streaming={false} />)
    expect(view.queryAllByRole('button')).toHaveLength(0)
    expect(view.getByText('Answer')).toBeTruthy()
  })
})

describe('ReasoningRow', () => {
  it('offers original and display text after expansion', () => {
    const calls = vi.fn()
    const extension: AssistantMarkdownProps['renderSlot'] = (key, owner, options) => {
      calls(key, owner)
      return renderSlot(key, owner, options)
    }
    const view = render(<ReasoningRow useDisclosure={useDisclosure} text="Original thought" running={false}
      usePresentation={useDetailedPresentation} renderSlot={extension} t={t} />)
    expect(calls).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button'))
    expect(calls).toHaveBeenCalledWith('conversation.chat.reasoning.body', { rawText: 'Original thought', text: 'Original thought', running: false })
    expect(view.getAllByText('Original thought')).toHaveLength(1)
    expect(view.getAllByRole('button')).toHaveLength(1)
  })

  it.each([
    ['', ''],
    ['An unfinished line', ''],
    ['A completed first line\nUnfinished continuation', 'A completed first line'],
    ['First\nSecond\nThird\n', 'First'],
    ['First\n\nNext unfinished', 'First'],
    ['First\n\nNext complete\nDetails', 'Next complete'],
    ['First\n\n\nNext complete\n', 'Next complete'],
    ['First\n \n\t\nNext complete\nDetails', 'Next complete'],
    ['First\r\n\r\n\r\nNext complete\r\n', 'Next complete'],
    ['First\r\n \r\n\t\r\nNext complete\r\nDetails', 'Next complete'],
    ['First\n\n\nNext unfinished', 'First'],
    ['\n\n\nFirst complete\n', 'First complete'],
    ['First\r\n \t\r\nNext complete\r\n', 'Next complete'],
    ['First\n\n\n', 'First'],
  ])('previews the completed paragraph first line for %j', (text, summary) => {
    const view = render(<ReasoningRow renderSlot={renderSlot} useDisclosure={useDisclosure}
      text={text} running usePresentation={useDetailedPresentation} t={t} />)
    const root = view.container.querySelector('[data-variant="think"]')!
    expect(root.querySelector('[class*="summaryText"]')?.textContent).toBe(summary)
    expect(root.hasAttribute('data-preview')).toBe(summary !== '')
  })

  it('retains summaries and expanded Markdown when the work-details mode changes', () => {
    const reset = createSnapshotStore(0)
    const useDisclosure = bindDisclosure(reset)
    const mode = createSnapshotStore<TranscriptViewMode>('standard')
    const usePresentation = bindSnapshotSelector(derivePresentationPolicy(mode, createSnapshotStore<CollapseTiming>('completion'), createSnapshotStore<FoldedReplies>('all')))
    const view = render(<ReasoningRow renderSlot={renderSlot} useDisclosure={useDisclosure}
      text={'First line\n\nDetailed body'} running={false} usePresentation={usePresentation} t={t} />)
    const root = view.container.querySelector('[data-variant="think"]')!
    const summary = view.getByText('First line')
    const toggle = view.getByRole('button')
    for (const next of ['compact', 'standard', 'detailed', 'verbose', 'compact'] as const) {
      act(() => { mode.set(next) })
      expect(view.getByText('First line')).toBe(summary)
      expect(root.hasAttribute('data-preview')).toBe(next !== 'compact')
      expect(root.querySelector('[data-markdown-variant]')).toBeNull()
    }
    fireEvent.click(toggle)
    const body = view.getByText('Detailed body')
    for (const next of ['standard', 'detailed', 'verbose', 'compact'] as const) {
      act(() => { mode.set(next) })
      expect(view.getByText('Detailed body')).toBe(body)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(root.hasAttribute('data-preview')).toBe(false)
    }
    act(() => { reset.set(1) })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('Detailed body')).toBeNull()
    expect(view.getByRole('button')).toBe(toggle)
  })

  it('keeps a running preview enabled in Compact and hides it on settlement without removing it', () => {
    const mode = createSnapshotStore<TranscriptViewMode>('compact')
    const usePresentation = bindSnapshotSelector(derivePresentationPolicy(mode, createSnapshotStore<CollapseTiming>('completion'), createSnapshotStore<FoldedReplies>('all')))
    const props = { text: 'First line\n', usePresentation, t }
    const view = render(<ReasoningRow renderSlot={renderSlot} useDisclosure={useDisclosure} {...props} running />)
    const summary = view.getByText('First line')
    const root = view.container.querySelector('[data-variant="think"]')!
    expect(root.hasAttribute('data-preview')).toBe(true)
    view.rerender(<ReasoningRow renderSlot={renderSlot} useDisclosure={useDisclosure} {...props} running={false} />)
    expect(root.hasAttribute('data-preview')).toBe(false)
    expect(view.getByText('First line')).toBe(summary)
  })

  it.each([
    { kind: 'text' as const, text: 'Answer' },
    { kind: 'tool-call' as const, callId: 'call-1', name: 'read', argsRaw: '{}' },
  ])('starts collapsed and preserves manual expansion when $kind arrives', (nextBlock) => {
    const reasoning = { kind: 'reasoning' as const, text: 'Inspect the session\nCheck persistence' }
    const view = render(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning]} streaming loadImage={unusedImageLoader} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByText('思考'))
    view.rerender(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning, nextBlock]} streaming loadImage={unusedImageLoader} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    view.rerender(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning, nextBlock]} streaming={false} loadImage={unusedImageLoader} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()
    fireEvent.click(view.getByText('思考'))
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('advances on completed paragraph first lines, then restores the settled first line', () => {
    const view = render(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nDetails\n\nNewest reasoning tokens\n' }]}
        streaming
        loadImage={unusedImageLoader}
      />,
    )
    expect(view.getByText('运行中')).toBeTruthy()
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('Newest reasoning tokens').closest('[data-streaming]')?.getAttribute('data-streaming'))
      .toBe('true')

    view.rerender(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nDetails\n\nNewest reasoning tokens\nMore details\n\nChecking boundaries' }]}
        streaming
        loadImage={unusedImageLoader}
      />,
    )
    expect(view.getByText('Newest reasoning tokens').closest('[data-streaming]')
      ?.getAttribute('data-streaming')).toBe('true')
    expect(view.queryByText('Checking boundaries')).toBeNull()

    const text = 'Inspect the session\nDetails\n\nNewest reasoning tokens\nMore details\n\nChecking boundaries\n'
    view.rerender(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming
        loadImage={unusedImageLoader}
      />,
    )
    expect(view.getByText('Checking boundaries')).toBeTruthy()
    expect(view.queryByText('Newest reasoning tokens')).toBeNull()

    view.rerender(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={false}
        loadImage={unusedImageLoader}
      />,
    )
    const settledSummary = view.getByText('Inspect the session')
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('运行中')).toBeNull()
    expect(settledSummary.closest('[data-streaming]')).toBeNull()
  })

  it('expands from either Think or the reasoning summary', () => {
    const view = render(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        loadImage={unusedImageLoader}
      />,
    )
    const row = view.getByRole('button')

    fireEvent.click(view.getByText('Inspect the session'))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()

    fireEvent.click(view.getByText('思考'))
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    {
      label: 'settled',
      text: '**Comparing checkout and merge bases**\nKeep **reviewing**',
      streaming: false,
    },
    {
      label: 'streaming',
      text: 'Inspect the session\n\n**Comparing checkout and merge bases**\n',
      streaming: true,
    },
  ])('strips double-asterisk markers from the $label summary and renders body emphasis', ({ text, streaming }) => {
    const view = render(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={streaming}
        loadImage={unusedImageLoader}
      />,
    )

    expect(view.getByText('Comparing checkout and merge bases')).toBeTruthy()
    expect(view.queryByText('**Comparing checkout and merge bases**')).toBeNull()

    fireEvent.click(view.getByText('思考'))
    expect(view.getByText('Comparing checkout and merge bases').tagName).toBe('STRONG')
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).not.toContain('**')
  })

  it('keeps heading syntax in the collapsed summary and renders compact headings when expanded', () => {
    const text = Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} Section ${index + 1}`)
      .join('\n\n') + '\n\nReasoning body.'
    const view = render(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={false}
        loadImage={unusedImageLoader}
      />,
    )
    const summary = view.getByText('# Section 1')
    expect(summary.tagName).toBe('SPAN')
    expect(view.queryByRole('heading')).toBeNull()

    fireEvent.click(summary)
    const compact = view.container.querySelector('[data-markdown-variant="compact"]')
    expect(compact).not.toBeNull()
    expect(compact?.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(6)
    expect(compact?.querySelector('p')?.textContent).toBe('Reasoning body.')

    fireEvent.click(view.getByText('思考'))
    expect(view.getByText('# Section 1').tagName).toBe('SPAN')
    expect(view.queryByRole('heading')).toBeNull()
  })

  it('keeps completed reasoning blocks mounted while the open streaming tail grows', () => {
    const first = '## Investigation\n\n**Check persistence**\n\n'
    const view = render(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: first }]}
        streaming
        loadImage={unusedImageLoader}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    const heading = view.getByRole('heading', { name: 'Investigation' })
    const emphasis = view.getByText('Check persistence')
    const text = first + Array.from({ length: 8 }, (_, index) => `Paragraph ${index}.`).join('\n\n')
    view.rerender(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming
        loadImage={unusedImageLoader}
      />,
    )
    expect(view.getByRole('heading', { name: 'Investigation' })).toBe(heading)
    expect(view.getByText('Check persistence')).toBe(emphasis)
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).not.toContain('##')
  })

  it('expanded Think drops the inline summary and renders prose without an IN card', () => {
    const view = render(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        loadImage={unusedImageLoader}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    expect(view.getAllByText(/Inspect the session/)).toHaveLength(1)
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()
  })

  it('anchors the sticky-header selector: only an open Think row nests the disclosure row under data-expanded and data-open', () => {
    const view = render(
      <AssistantMarkdown renderSlot={renderSlot} useDisclosure={useDisclosure} useGroupAction={useSearchableHidden}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[
          { kind: 'reasoning', text: 'Inspect the session\nCheck persistence' },
          { kind: 'text', text: 'Answer' },
        ]}
        streaming={false}
        loadImage={unusedImageLoader}
      />,
    )
    // Collapsed: no `data-open`, so the sticky rule's gate never matches.
    expect(view.container.querySelector('[data-variant="think"] [data-open]')).toBeNull()
    fireEvent.click(view.getByText('思考'))
    expect(
      view.container.querySelector(
        '[data-variant="think"][data-expanded] [data-open] [data-disclosure-header]',
      ),
    ).not.toBeNull()
  })
})
