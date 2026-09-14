// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

describe('ReasoningRow', () => {
  it('collapses when body text arrives and preserves a later manual expansion', () => {
    const reasoning = { kind: 'reasoning' as const, text: 'Inspect the session\nCheck persistence' }
    const view = render(
      <AssistantMarkdown t={t} blocks={[reasoning]} streaming renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    view.rerender(
      <AssistantMarkdown t={t} blocks={[reasoning, { kind: 'text', text: 'Answer' }]}
        streaming renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByText('思考'))
    view.rerender(
      <AssistantMarkdown t={t} blocks={[reasoning, { kind: 'text', text: 'Complete answer' }]}
        streaming={false} renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()
  })

  it('follows the latest streaming line, then restores the settled first line', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('运行中')).toBeTruthy()
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(view.getByText('思考'))
    expect(view.getByText('Newest reasoning tokens').parentElement?.getAttribute('data-follow-end'))
      .toBe('true')

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('Newest reasoning tokens keep arriving').parentElement
      ?.getAttribute('data-follow-end')).toBe('true')

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving\n' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const settledSummary = view.getByText('Inspect the session')
    expect(view.queryByText('运行中')).toBeNull()
    expect(settledSummary.parentElement?.hasAttribute('data-follow-end')).toBe(false)
  })

  it('expands from either Think or the reasoning summary', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const row = view.getByRole('button')

    fireEvent.click(view.getByText('思考'))
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
      text: 'Inspect the session\n**Comparing checkout and merge bases**',
      streaming: true,
    },
  ])('strips double-asterisk markers from the $label summary without changing the reasoning body', ({ text, streaming }) => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={streaming}
        renderMessageImages={renderMessageImages}
      />,
    )

    fireEvent.click(view.getByText('思考'))
    expect(view.getByText('Comparing checkout and merge bases')).toBeTruthy()
    expect(view.queryByText('**Comparing checkout and merge bases**')).toBeNull()

    fireEvent.click(view.getByText('思考'))
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).toBe(text)
  })

  it('opens reasoning-only replies as plain prose and allows manual collapse', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(view.getAllByText(/Inspect the session/)).toHaveLength(1)
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()
    fireEvent.click(view.getByText('思考'))
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText(/Check persistence/)).toBeNull()
  })
})
