// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { IconClockOutlineRegular, IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { TurnTriggerNodeView } from '../src/client/chat/TurnTriggerNodeView.tsx'
import { turnTriggerDetails } from '../src/client/chat/turn-trigger.ts'
import { contextForm, contextProducer } from '../src/client/conversation-nodes/event-projection.ts'
import { en, zh } from '../src/client/locale.ts'

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
    [en, 'Requested to continue generation'],
    [zh, '已请求继续生成'],
  ])('shows an empty retry as a compact continuation receipt', (locale, title) => {
    const node = trigger({ kind: 'retry' })
    node.data.content = []
    expect(turnTriggerDetails(node.data)).toEqual({ title: 'message.continuation.requested', icon: 'continue', compact: true })
    const view = render(<TurnTriggerNodeView node={node} t={makeTranslate(locale)} />)
    expect(view.getByText(title)).toBeDefined()
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('[data-generation-continuation] svg')).not.toBeNull()
    expect(view.container.querySelector('time')).toBeNull()
  })

  it.each([
    [{ kind: 'schedule' }, 'schedule', 'Automation task'],
    [{ kind: 'tool-jobs' }, 'job', 'Background task updated'],
    [{ kind: 'cordis-host-runner' }, 'plugin', 'Plugin status updated'],
    [{ kind: 'goal' }, 'goal', 'Continuing goal'],
    [{ kind: 'agent-message' }, 'agent', 'Task message received'],
    [{ kind: 'team-message' }, 'team', 'Team message received'],
    [{ kind: 'subagent-settled' }, 'subagent', 'Subtask status updated'],
    [{ kind: 'webhook', provider: 'github' }, 'github', 'GitHub event received'],
    [{ kind: 'webhook', provider: 'custom' }, 'webhook', 'External event received'],
    [{ kind: 'custom-extension' }, 'request', 'Execution requested'],
    [{ kind: 'retry' }, 'request', 'Execution requested'],
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

  it.each([
    [en, 'Task message received'],
    [zh, '收到任务消息'],
  ])('presents Team relays as Agent messages while retaining the sender name', (locale, title) => {
    const node = trigger({ kind: 'agent-message', form: 'relay', senderSessionId: 'sender' })
    node.data.content = [{ type: 'text', text: 'Team message from reviewer-2:' }, { type: 'text', text: 'Ready.' }]
    expect(turnTriggerDetails(node.data)).toEqual({ title: 'message.trigger.agent', icon: 'agent' })
    const view = render(<TurnTriggerNodeView node={node} t={makeTranslate(locale)} />)
    expect(view.getByRole('button').textContent).toContain(title)
    fireEvent.click(view.getByRole('button'))
    expect(view.container.querySelector('[data-context-text]')?.textContent).toContain('Team message from reviewer-2:')
  })

  it.each([
    { locale: en, title: 'Automation task' },
    { locale: zh, title: '自动化任务' },
  ])('uses the automation task label $title and shared clock', ({ locale, title }) => {
    const node = trigger({ kind: 'schedule' })
    const view = render(<TurnTriggerNodeView node={node} t={makeTranslate(locale)} />)
    expect(view.getByRole('button').textContent).toContain(title)
    const reference = render(<IconClockOutlineRegular size={14} />)
    expect(view.getByRole('button').querySelector('svg')?.outerHTML)
      .toBe(reference.container.querySelector('svg')?.outerHTML)
    expect(node.data.source).toEqual({ kind: 'schedule' })
  })

  it.each([
    ['completed', 'Subagent run completed', '子智能体已完成任务'],
    ['aborted', 'Subagent run stopped', '子智能体任务已停止'],
    ['error', 'Subagent run failed', '子智能体执行失败'],
    ['max-tokens', 'Subagent reached the token limit', '子智能体已达 token 上限'],
    ['refusal', 'Subagent declined the task', '子智能体拒绝执行'],
    ['backend-specific', 'Subagent run ended unexpectedly', '子智能体异常结束'],
  ])('presents only the recorded %s outcome in both locales', (stopReason, english, chinese) => {
    const source = { kind: 'subagent-settled', stopReason, senderSessionId: 'child-1' }
    const node = trigger(source)
    const view = render(<TurnTriggerNodeView node={node} t={makeTranslate(en)} />)
    expect(view.getByRole('button').textContent).toContain(english)
    expect(view.getByRole('button').textContent).not.toContain(' · ')
    const reference = render(<IconUsersOutlineRegular size={14} />)
    expect(view.getByRole('button').querySelector('svg')?.outerHTML)
      .toBe(reference.container.querySelector('svg')?.outerHTML)
    view.rerender(<TurnTriggerNodeView node={node} t={makeTranslate(zh)} />)
    expect(view.getByRole('button').textContent).toContain(chinese)
    expect(view.getByRole('button').textContent).not.toContain(' · ')
    fireEvent.click(view.getByRole('button'))
    expect(view.container.querySelector('[data-context-text]')?.textContent)
      .toBe('Recorded notification\nwith its original body.')
    expect(node.data.source).toEqual(source)
  })

  it.each([undefined, null, false, 12, {}, '', []])('does not infer an absent or malformed outcome %j from English text', (stopReason) => {
    const node = trigger({ kind: 'subagent-settled', stopReason, summary: 'Background subagent child-1 finished.' })
    node.data.content = [{ type: 'text', text: 'Background subagent child-1 finished.' }]
    expect(turnTriggerDetails(node.data)).toEqual({ title: 'message.trigger.subagent', icon: 'subagent' })
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
