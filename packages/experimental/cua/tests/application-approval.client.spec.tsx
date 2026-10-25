// @vitest-environment jsdom
/** Fixed decisions retain the caller's answer labels and pending-question lifetime. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApprovalCardInput } from '@deepseek-ai/dsh-client-ui-approval/client'
import { PendingQuestion, createWaterfallRequest } from '@deepseek-ai/dsh-client-ui-user-questions/src/client/contract/slots.ts'
import { ApplicationApproval, selectApplicationApproval, type ApplicationApprovalProps } from '../src/client/ApplicationApproval.tsx'

type AskUserQuestionItem = PendingQuestion['questions'][number]
type ApprovalIntent = Extract<NonNullable<AskUserQuestionItem['intent']>, { kind: 'approval' }>
type SessionId = ConstructorParameters<typeof PendingQuestion>[0]

afterEach(cleanup)

it('leaves ordinary questions, plan reviews and other approval intents to their existing renderers', () => {
  const application: AskUserQuestionItem = { id: 'cua-app-access', question: 'Allow?', detail: 'Scope',
    options: [{ label: 'Allow' }, { label: 'Deny' }], intent: { kind: 'approval', approve: 'Allow', reject: 'Deny' } }
  expect(selectApplicationApproval(undefined)).toBeNull()
  for (const questions of [[], [application, application], [{ ...application, id: 'another-feature' }],
    [{ id: 'cua-app-access', question: 'Plain question' }],
    [{ ...application, intent: { kind: 'plan-review' as const, approve: 'Allow' } }],
  ]) {
    expect(selectApplicationApproval(new PendingQuestion('s1' as SessionId, questions))).toBeNull()
  }
})

it.each(['allow', 'reject', 'always'] as const)('returns the exact %s option from the shared card', async (choice) => {
  const intent: ApprovalIntent = {
    kind: 'approval', approve: 'task-value', reject: 'deny-value', always: 'saved-value',
    subject: { name: 'Calculator' }, display: { question: { en: 'Allow?', zh: '允许吗？' },
      detail: { en: 'Scope', zh: '本次任务' }, approve: { en: 'Task', zh: '本次任务允许' } },
  }
  const item: AskUserQuestionItem = { id: 'cua-app-access', question: 'English question', detail: 'English detail', intent }
  const pending = new PendingQuestion('s1' as SessionId, [item])
  const request = createWaterfallRequest(undefined, undefined, () => {})
  pending.attachWaterfall(request.channel)
  const factory = vi.fn((_name: string, _input: ApprovalCardInput) => null)
  render(<ApplicationApproval {...{ matched: selectApplicationApproval(pending)!, renderFactorySlot: factory,
    resolveText: text => text.zh ?? text.en } as ApplicationApprovalProps} />)
  const [name, card] = factory.mock.calls[0]!
  expect(name).toBe('conversation.approval.card')
  expect(card).toMatchObject({ title: '允许吗？', description: '本次任务', allowLabel: '本次任务允许', subject: { name: 'Calculator' } })
  expect(card.canAnswer()).toBe(true)
  await ({ allow: card.onAllow, reject: card.onReject, always: card.onAlways! })[choice]()
  expect(await request.result).toEqual({ answers: [{ id: 'cua-app-access', selected: [{ allow: 'task-value', reject: 'deny-value', always: 'saved-value' }[choice]] }] })
  pending.close()
  expect(card.canAnswer()).toBe(false)
})

it('keeps unsupported persistence absent and uses caller text when no localized metadata exists', () => {
  const item: AskUserQuestionItem = { id: 'cua-app-access', question: 'Allow?',
    intent: { kind: 'approval', approve: 'Task', reject: 'Deny' } }
  const pending = new PendingQuestion('s1' as SessionId, [item])
  const factory = vi.fn((_name: string, _input: ApprovalCardInput) => null)
  const props = { matched: selectApplicationApproval(pending)!, renderFactorySlot: factory,
    resolveText: text => text.en } as ApplicationApprovalProps
  const view = render(<ApplicationApproval {...props} />)
  expect(factory.mock.calls[0]?.[1]).toMatchObject({ title: 'Allow?', allowLabel: 'Task' })
  expect(factory.mock.calls[0]?.[1]).not.toHaveProperty('onAlways')
  expect(factory.mock.calls[0]?.[1]).not.toHaveProperty('subject')
  expect(factory.mock.calls[0]?.[1]).not.toHaveProperty('description')
  expect(factory.mock.calls[0]?.[1].canAnswer()).toBe(false)
  const detailed = new PendingQuestion('s1' as SessionId, [{ ...item, detail: 'Scope' }])
  view.rerender(<ApplicationApproval {...props} matched={selectApplicationApproval(detailed)!} />)
  expect(factory.mock.calls.at(-1)?.[1].description).toBe('Scope')
})

it('uses the original question cancellation and refuses late approval', async () => {
  const pending = new PendingQuestion('s1' as SessionId, [{ id: 'cua-app-access', question: 'Allow?',
    intent: { kind: 'approval', approve: 'Allow', reject: 'Deny' } }])
  const controller = new AbortController()
  const request = createWaterfallRequest(undefined, controller.signal, (channel) => { pending.detachWaterfall(channel) })
  pending.attachWaterfall(request.channel)
  const factory = vi.fn((_name: string, _input: ApprovalCardInput) => null)
  render(<ApplicationApproval {...{ matched: selectApplicationApproval(pending)!, renderFactorySlot: factory,
    resolveText: text => text.en } as ApplicationApprovalProps} />)
  const card = factory.mock.calls[0]![1]
  const rejected = expect(request.result).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  controller.abort()
  await rejected
  expect(card.canAnswer()).toBe(false)
  await expect(card.onAllow()).rejects.toThrow('no channel accepts an answer yet')
})
