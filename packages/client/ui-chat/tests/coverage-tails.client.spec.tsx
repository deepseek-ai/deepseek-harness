// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { zh } from '../src/client/locale.ts'

const t: AssistantMarkdownProps['t'] = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

afterEach(cleanup)

describe('tails', () => {
  it('AssistantMarkdown renders reasoning as a Think row and unknown blocks as JSON fallback', () => {
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[
          { kind: 'reasoning', text: 'thinking hard\nsecond line' },
          { kind: 'tool-call', callId: 'c', name: 'bash', argsRaw: '{}' },
          { kind: 'other', block: { type: 'mystery' } },
        ]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('思考')).toBeTruthy()
    expect(view.getByText('thinking hard')).toBeTruthy()
    expect(view.getByText(/未知内容块/)).toBeTruthy()
    const stopped = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'text', text: 'partial words' }]}
        streaming={false}
        interrupted
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(stopped.getByText('已停止')).toBeTruthy()
  })

  it('AssistantMarkdown skips the root shell when only tool-call heads remain', () => {
    // Tool heads are drawn by ChatView's tool groups; an empty root between
    // groups is layout noise (no text, no pulse, no interrupted marker).
    const empty = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'tool-call', callId: 'c', name: 'todo_write', argsRaw: '{}' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(empty.container.firstChild).toBeNull()
    const blank = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[]} streaming={false} renderMessageImages={renderMessageImages} />,
    )
    expect(blank.container.firstChild).toBeNull()
  })

})
