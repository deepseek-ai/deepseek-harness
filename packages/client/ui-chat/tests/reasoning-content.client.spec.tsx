// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, within } from '@testing-library/react'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createReasoningRenderFixture } from './reasoning-render-fixture.tsx'

const CODE = '```text\nfirst line\nsecond line\n```'
const labels: MarkdownLabels = {
  code: {
    copyLabel: 'Copy snippet', copiedLabel: 'Snippet copied',
    toolbarLabels: { codeLabel: 'Snippet', wrapLabel: 'Wrap snippet', unwrapLabel: 'Unwrap snippet' },
  },
  footnotes: 'References',
}

type WrappedBodyProps = PropsRuntime<'conversation.chat.reasoning.body'> & PropsRenderFactories

function WrappedBody({ text, running, renderFactorySlot }: WrappedBodyProps) {
  const [original, setOriginal] = useState(false)
  return <section data-testid="wrapper">
    <button onClick={() => { setOriginal(value => !value) }}>Switch body</button>
    {renderFactorySlot('conversation.chat.reasoning.content', { text: original ? text : `Wrapped ${text}`, running })}
  </section>
}

afterEach(cleanup)

describe('reasoning Content Factory', () => {
  it('renders without a Session Provider and uses the current Chat labels by default', async () => {
    const b = await createReasoningRenderFixture('en')
    const view = b.render(b.renderFactorySlot('conversation.chat.reasoning.content', { text: CODE, running: false }))
    expect(view.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Wrap lines' })).toBeTruthy()
    expect(view.container.querySelector('[data-markdown-variant="compact"]')).not.toBeNull()
    expect(b.runtime.factoryOf('conversation.chat.reasoning.content').scope).toBe('root')
  })

  it('uses complete caller labels unchanged and returns to defaults when they are omitted', async () => {
    const b = await createReasoningRenderFixture('en')
    const view = b.render(b.renderFactorySlot('conversation.chat.reasoning.content', { text: CODE, running: false, labels }))
    const markdown = view.container.querySelector('[data-markdown-variant="compact"]')
    expect(view.getByRole('button', { name: 'Copy snippet' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Wrap snippet' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Copy' })).toBeNull()
    view.rerender(b.renderFactorySlot('conversation.chat.reasoning.content', { text: CODE, running: false }))
    expect(view.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Copy snippet' })).toBeNull()
    expect(view.container.querySelector('[data-markdown-variant="compact"]')).toBe(markdown)
  })

  it('keeps code wrapping state independent between two Factory occurrences', async () => {
    const b = await createReasoningRenderFixture('en')
    const view = b.render(<>
      <section data-testid="first">{b.renderFactorySlot('conversation.chat.reasoning.content', { text: CODE, running: false })}</section>
      <section data-testid="second">{b.renderFactorySlot('conversation.chat.reasoning.content', { text: CODE, running: false })}</section>
    </>)
    const first = within(view.getByTestId('first')).getByRole('button', { name: 'Wrap lines' })
    const second = within(view.getByTestId('second')).getByRole('button', { name: 'Wrap lines' })
    expect(first.getAttribute('aria-pressed')).toBe('true')
    expect(second.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(first)
    expect(first.getAttribute('aria-pressed')).toBe('false')
    expect(second.getAttribute('aria-pressed')).toBe('true')
  })

  it('restores the registered default after a wrapping plugin unloads and removes the Factory with its owner', async () => {
    const b = await createReasoningRenderFixture('en')
    const view = b.render(b.renderSlot('conversation.chat.reasoning.body', { text: 'Original thought', running: false }))
    expect(view.getByText('Original thought')).toBeTruthy()
    expect(b.runtime.slots.entries('conversation.chat.reasoning.body')[0]?.options.priority).toBe(100)
    const plugin = await b.runtime.mount({ inject: ['slots'], apply: (ctx) => {
      ctx.slots.inject('conversation.chat.reasoning.body', () => ctx.slots.register({
        name: 'conversation.chat.reasoning.body',
      }, WrappedBody))
    } })
    expect(view.getByText('Wrapped Original thought')).toBeTruthy()
    expect(view.queryByText('Original thought', { exact: true })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Switch body' }))
    expect(view.getByText('Original thought')).toBeTruthy()
    await plugin.dispose()
    expect(view.queryByTestId('wrapper')).toBeNull()
    expect(view.getByText('Original thought')).toBeTruthy()
    expect(view.queryAllByRole('button')).toHaveLength(0)
    view.unmount()
    await b.owner.dispose()
    expect(b.runtime.slots.entries('conversation.chat.reasoning.body')).toHaveLength(0)
    expect(() => b.runtime.factoryOf('conversation.chat.reasoning.content')).toThrow('no definition')
  })
})
