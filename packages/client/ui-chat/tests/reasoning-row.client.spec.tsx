// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import type { TranscriptViewMode } from '../src/chat-settings.ts'
import { derivePresentationPolicy } from '../src/client/presentation-policy.ts'
import { ReasoningRow } from '../src/client/chat/ReasoningRow.tsx'
import { bindDisclosure, useDisclosure } from '../src/client/chat/use-disclosure.ts'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

describe('ReasoningRow', () => {
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
    const view = render(<ReasoningRow useDisclosure={useDisclosure} text={text} running usePresentation={useDetailedPresentation} t={t} />)
    const root = view.container.querySelector('[data-variant="think"]')!
    expect(root.querySelector('[class*="summaryText"]')?.textContent).toBe(summary)
    expect(root.hasAttribute('data-preview')).toBe(summary !== '')
  })

  it('retains summaries and expanded Markdown when the work-details mode changes', () => {
    const reset = createSnapshotStore(0)
    const useDisclosure = bindDisclosure(reset)
    const mode = createSnapshotStore<TranscriptViewMode>('standard')
    const usePresentation = bindSnapshotSelector(derivePresentationPolicy(mode))
    const view = render(<ReasoningRow useDisclosure={useDisclosure}
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
    const usePresentation = bindSnapshotSelector(derivePresentationPolicy(mode))
    const props = { text: 'First line\n', usePresentation, t }
    const view = render(<ReasoningRow useDisclosure={useDisclosure} {...props} running />)
    const summary = view.getByText('First line')
    const root = view.container.querySelector('[data-variant="think"]')!
    expect(root.hasAttribute('data-preview')).toBe(true)
    view.rerender(<ReasoningRow useDisclosure={useDisclosure} {...props} running={false} />)
    expect(root.hasAttribute('data-preview')).toBe(false)
    expect(view.getByText('First line')).toBe(summary)
  })

  it.each([
    { kind: 'text' as const, text: 'Answer' },
    { kind: 'tool-call' as const, callId: 'call-1', name: 'read', argsRaw: '{}' },
  ])('starts collapsed and preserves manual expansion when $kind arrives', (nextBlock) => {
    const reasoning = { kind: 'reasoning' as const, text: 'Inspect the session\nCheck persistence' }
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning]} streaming renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByText('思考'))
    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning, nextBlock]} streaming renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning, nextBlock]} streaming={false} renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()
    fireEvent.click(view.getByText('思考'))
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('advances on completed paragraph first lines, then restores the settled first line', () => {
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nDetails\n\nNewest reasoning tokens\n' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('运行中')).toBeTruthy()
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('Newest reasoning tokens').parentElement?.getAttribute('data-streaming'))
      .toBe('true')

    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nDetails\n\nNewest reasoning tokens\nMore details\n\nChecking boundaries' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('Newest reasoning tokens').parentElement
      ?.getAttribute('data-streaming')).toBe('true')
    expect(view.queryByText('Checking boundaries')).toBeNull()

    const text = 'Inspect the session\nDetails\n\nNewest reasoning tokens\nMore details\n\nChecking boundaries\n'
    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('Checking boundaries')).toBeTruthy()
    expect(view.queryByText('Newest reasoning tokens')).toBeNull()

    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const settledSummary = view.getByText('Inspect the session')
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('运行中')).toBeNull()
    expect(settledSummary.parentElement?.hasAttribute('data-streaming')).toBe(false)
  })

  it('expands from either Think or the reasoning summary', () => {
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
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
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={streaming}
        renderMessageImages={renderMessageImages}
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
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
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
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: first }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    const heading = view.getByRole('heading', { name: 'Investigation' })
    const emphasis = view.getByText('Check persistence')
    const text = first + Array.from({ length: 8 }, (_, index) => `Paragraph ${index}.`).join('\n\n')
    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByRole('heading', { name: 'Investigation' })).toBe(heading)
    expect(view.getByText('Check persistence')).toBe(emphasis)
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).not.toContain('##')
  })

  it('expanded Think drops the inline summary and renders prose without an IN card', () => {
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
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
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[
          { kind: 'reasoning', text: 'Inspect the session\nCheck persistence' },
          { kind: 'text', text: 'Answer' },
        ]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    // Collapsed: no `data-open`, so the sticky rule's gate never matches.
    expect(view.container.querySelector('[data-variant="think"] [data-open]')).toBeNull()
    fireEvent.click(view.getByText('思考'))
    expect(
      view.container.querySelector(
        '[data-variant="think"][data-expanded] [data-open] [data-disclosure-row]',
      ),
    ).not.toBeNull()
  })
})
