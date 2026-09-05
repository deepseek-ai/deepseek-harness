// @vitest-environment jsdom
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatConversationViewNode, ChatSnapshot,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { commandDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/command.ts'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { GoalCommandInputView } from '../src/client/GoalCommandInputView.tsx'
import {
  goalCommandInputDefinition, goalCommandText,
} from '../src/client/goal-command-input.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return [commandDefinition, goalCommandInputDefinition]
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function entry(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return {
    type: 'event',
    event: { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent,
  }
}

function snapshot(entries: readonly SessionLiveEventEntry[], hasMore = false): ChatSnapshot {
  const assembler = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  assembler.replaceWindow(entries, hasMore)
  assembler.activateTarget('chat')
  const value = assembler.snapshot('chat') as ChatSnapshot | undefined
  if (value === undefined) throw new Error('chat view was not registered')
  return value
}

function node(value: ChatSnapshot, kind: string): ChatConversationViewNode | undefined {
  return value.nodes.values().find(candidate => candidate.kind === kind)
}

describe('goal command input projection', () => {
  it('builds a separate input Node before the generic command result and restores it on replay', () => {
    const run = entry(1, 'command/run', {
      commandId: 'command-goal', name: 'goal', args: ' ', source: { kind: 'user' },
    })
    const done = entry(2, 'command/done', {
      commandId: 'command-goal', kind: 'success', text: 'No goal is currently set.',
    })
    const value = snapshot([run, done])

    expect(value.order.map(key => value.nodes.get(key)?.kind)).toEqual(['command-input', 'command'])
    expect(node(value, 'command-input')).toMatchObject({
      anchorSeq: 0.9,
      data: { commandId: 'command-goal', text: '/goal' },
    })
    expect(node(value, 'command')?.data).toMatchObject({
      name: 'goal', args: ' ', outcome: { kind: 'success', text: 'No goal is currently set.' },
    })

    const doneOnly = snapshot([done], true)
    expect(node(doneOnly, 'command-input')).toBeUndefined()
    expect(node(doneOnly, 'command')?.data).toMatchObject({ name: null, args: null })
  })

  it('ignores other commands and preserves internal multiline arguments', () => {
    const plan = entry(1, 'command/run', {
      commandId: 'command-plan', name: 'plan', args: '', source: { kind: 'user' },
    })
    const goal = entry(2, 'command/run', {
      commandId: 'command-goal', name: 'goal', args: '\nfirst line\nsecond line \n', source: { kind: 'user' },
    })

    expect(goalCommandInputDefinition.match(plan.event)).toBeNull()
    expect(goalCommandText(goal.event as SessionEvent<'command/run'>))
      .toBe('/goal\nfirst line\nsecond line')
  })

  it('keeps the Definition total across required interface and window fallback paths', () => {
    const run = entry(3, 'command/run', {
      commandId: 'command-goal', name: 'goal', source: { kind: 'user' },
    })
    const match = {
      ...run,
      role: 'start' as const,
      location: { kind: 'session' as const },
    }
    const state = goalCommandInputDefinition.start({} as never, match, {} as never)

    expect(state.text).toBe('/goal')
    expect(goalCommandInputDefinition.update({ state } as never, match)).toBe(state)
    expect(goalCommandInputDefinition.buildViewNode!({ state: undefined } as never)).toBeNull()
    expect(goalCommandInputDefinition.buildViewNode!({
      key: 'goal-command-input', id: 'command-goal', state, start: undefined,
    } as never)).toMatchObject({ location: { kind: 'unresolved' } })

    const done = entry(4, 'command/done', { commandId: 'command-goal', kind: 'success' })
    expect(() => goalCommandInputDefinition.start({} as never, {
      ...done, role: 'start', location: { kind: 'session' },
    } as never, {} as never)).toThrow('goal-command-input start requires command/run')
  })

  it('renders the user-style command bubble without ordinary message actions', () => {
    const t = makeTranslate(zh, commonZh)
    const props = {
      node: {
        key: 'goal-command-input:one',
        data: { commandId: 'command-goal', text: '/goal ship it', time: 1_700_000_000_000 },
      },
      t,
    } as unknown as Parameters<typeof GoalCommandInputView>[0]
    const view = render(<GoalCommandInputView {...props} />)
    const bubble = view.getByRole('group', { name: '指令输入' })

    expect(bubble.textContent).toBe('/goal ship it')
    expect(within(bubble).queryByRole('button')).toBeNull()
    // The executed command token reads as a reference chip; the objective stays plain text.
    const chips = [...bubble.querySelectorAll('[data-ref-chip]')]
    expect(chips.map(chip => [chip.getAttribute('data-ref-chip'), chip.textContent])).toEqual([['command', '/goal']])
  })

  it('renders a bare /goal as one command chip and nothing else', () => {
    const t = makeTranslate(zh, commonZh)
    const props = {
      node: {
        key: 'goal-command-input:bare',
        data: { commandId: 'command-goal', text: '/goal', time: 1_700_000_000_000 },
      },
      t,
    } as unknown as Parameters<typeof GoalCommandInputView>[0]
    const view = render(<GoalCommandInputView {...props} />)
    const bubble = view.getByRole('group', { name: '指令输入' })
    expect(bubble.textContent).toBe('/goal')
    expect([...bubble.querySelectorAll('[data-ref-chip]')].map(chip => chip.textContent)).toEqual(['/goal'])
  })

  it('decorates only the leading command token: a /goal inside the objective stays plain', () => {
    const t = makeTranslate(zh, commonZh)
    const props = {
      node: {
        key: 'goal-command-input:two',
        data: { commandId: 'command-goal', text: '/goal 检查 /goal 的语法', time: 1_700_000_000_000 },
      },
      t,
    } as unknown as Parameters<typeof GoalCommandInputView>[0]
    const view = render(<GoalCommandInputView {...props} />)
    const bubble = view.getByRole('group', { name: '指令输入' })
    expect(bubble.textContent).toBe('/goal 检查 /goal 的语法')
    const chips = [...bubble.querySelectorAll('[data-ref-chip]')]
    expect(chips.map(chip => chip.textContent)).toEqual(['/goal'])
  })
})
