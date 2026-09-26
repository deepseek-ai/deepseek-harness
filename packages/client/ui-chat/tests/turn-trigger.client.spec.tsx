// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { TurnTriggerNodeView } from '../src/client/chat/TurnTriggerNodeView.tsx'
import { turnTriggerDetails } from '../src/client/chat/turn-trigger.ts'
import { contextForm, contextProducer } from '../src/client/conversation-nodes/event-projection.ts'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

function trigger(source: unknown): ChatNode<'turn-trigger'> {
  return {
    key: 'input-message:notice', kind: 'turn-trigger', id: 'notice', target: 'chat',
    anchorSeq: 4, location: { kind: 'unresolved' }, visibility: 'visible',
    data: {
      kind: 'context', seq: 4, time: 1_700_000_000_000,
      content: [{ type: 'text', text: 'Recorded notification\nwith its original body.' }],
      source, form: contextForm(source), producer: contextProducer(source),
    },
  }
}

describe('Turn trigger notices', () => {
  it.each([
    [{ kind: 'schedule' }, 'schedule', 'Scheduled task'],
    [{ kind: 'tool-jobs' }, 'job', 'Background task updated'],
    [{ kind: 'cordis-host-runner' }, 'plugin', 'Plugin status updated'],
    [{ kind: 'goal' }, 'goal', 'Continuing goal'],
    [{ kind: 'agent-message' }, 'agent', 'Task message received'],
    [{ kind: 'team-message' }, 'team', 'Team message received'],
    [{ kind: 'subagent-settled' }, 'subagent', 'Subtask status updated'],
    [{ kind: 'webhook', provider: 'github' }, 'github', 'GitHub event received'],
    [{ kind: 'webhook', provider: 'custom' }, 'webhook', 'External event received'],
    [{ kind: 'custom-extension' }, 'request', 'Execution requested'],
  ] as const)('presents the recorded %j source', (source, icon, title) => {
    const node = trigger(source)
    const details = turnTriggerDetails(node.data)
    expect(details).toEqual({ title: `message.trigger.${icon}`, icon })
    const t = makeTranslate(en)
    const view = render(<TurnTriggerNodeView node={node} t={t} />)
    expect(view.getByRole('button').textContent).toContain(title)
    expect(view.getByRole('button').querySelector('svg')).not.toBeNull()
    expect(view.container.querySelector('time')?.dateTime).toBe('2023-11-14T22:13:20.000Z')
  })

  it('opens the recorded notice body and closes it independently of the Turn', () => {
    const view = render(<TurnTriggerNodeView node={trigger({ kind: 'schedule' })} t={makeTranslate(en)} />)
    const button = view.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-context-text]')).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(button.getAttribute('aria-controls')!)).not.toBeNull()
    expect(view.container.querySelector('[data-context-text]')?.textContent)
      .toBe('Recorded notification\nwith its original body.')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-context-text]')).toBeNull()
  })

  it.each([null, [], 'external-source', {}, { kind: 5 }, { kind: 'webhook', provider: 5 }])(
    'keeps an opaque source %j readable without invented attribution', (source) => {
      const details = turnTriggerDetails(trigger(source).data)
      const webhook = typeof source === 'object' && source !== null && 'kind' in source && source.kind === 'webhook'
      expect(details).toEqual(webhook
        ? { title: 'message.trigger.webhook', icon: 'webhook' }
        : { title: 'message.trigger.request', icon: 'request' })
    },
  )
})
