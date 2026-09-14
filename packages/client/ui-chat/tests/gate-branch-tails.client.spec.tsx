// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { StatsPills } from '../src/client/chat/StatsPills.tsx'
import { zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

const t: AssistantMarkdownProps['t'] = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})


describe('render branch tails', () => {
  it('AssistantMarkdown reasoning row is ok-state when not the streaming tail', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'done thinking' }, { kind: 'text', text: 'answer' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    // reasoning at index 0 with a later block: running is false → ok state.
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it('StatsPills falls back to window-node counts and drops the usage pill without projections', () => {
    // No sessionStats key → the window fold supplies the counts (the
    // assembly-without-the-unit fallback). Node `usage` is deliberately
    // ignored: billing rides the durable tokenUsage projection, so an absent
    // projection leaves counts only.
    const nodes = [
      { kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, blocks: [] },
      { kind: 'assistant', seq: 2, time: 2, turn: 1, step: 2, blocks: [], usage: { inputTokens: 4, outputTokens: 6 } },
      { kind: 'assistant', seq: 3, time: 3, turn: 2, step: 1, blocks: [], usage: { inputTokens: 5 } },
    ] as const
    const snap = chatSnapshotFixture({ nodes })
    const source = { getSnapshot: () => snap, subscribe: () => () => {} }
    const view = render(
      <StatsPills
        t={t}
        useChat={bindSnapshotSelector(source)}
        useProjection={() => undefined}
      />,
    )
    expect(view.container.textContent).toBe('2 轮 3 步')
    // Window-fold counts carry no timed figure, so the pill is a static reading.
    expect(view.queryAllByRole('button')).toHaveLength(0)
  })

  it('AssistantMarkdown reasoning as the streaming tail renders the running ring', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'still thinking' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

})
