/** Consent answering: unattended approval of the connection's Agent, or an elicitation round trip. */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserQuestionError, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { approveAll, CONSENT_MODES, createConsentAnswerer, elicitAnswer, type ElicitationClient } from '../src/consent.ts'

const approval: AskUserQuestionItem = {
  id: 'cua-app-access', question: 'Allow computer use to control Notes?', detail: 'The session may read and operate the application.',
  options: [{ label: 'Allow for this session' }, { label: 'Deny' }, { label: 'Always allow' }],
  intent: { kind: 'approval', approve: 'Allow for this session', reject: 'Deny', always: 'Always allow' },
}
const generic: AskUserQuestionItem = { id: 'format', question: 'Which format?', options: [{ label: 'CSV' }, { label: 'JSON' }] }
const agent = { id: 'connection' } as Agent
const other = { id: 'other' } as Agent

function client(result: Awaited<ReturnType<ElicitationClient['elicit']>>, supported = true) {
  const elicit = vi.fn<ElicitationClient['elicit']>(async () => result)
  return { client: { supportsElicitation: () => supported, elicit } satisfies ElicitationClient, elicit }
}

describe('allow mode', () => {
  it('selects the approving label of every approval question and refuses other questions', () => {
    expect(approveAll([approval])).toEqual({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
    expect(approveAll([approval, generic])).toBeUndefined()
    expect(CONSENT_MODES).toEqual(['allow', 'elicit'])
  })

  it('answers only the connection Agent and delegates everything else', async () => {
    const next = vi.fn(async () => ({ answers: [{ id: 'format', selected: ['CSV'] }] }))
    const answer = createConsentAnswerer('allow', candidate => candidate === agent, client({ action: 'cancel' }).client)
    expect(await answer({ questions: [approval], agent }, next)).toEqual({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] })
    expect(await answer({ questions: [approval], agent: other }, next)).toEqual({ answers: [{ id: 'format', selected: ['CSV'] }] })
    expect(await answer({ questions: [generic], agent }, next)).toEqual({ answers: [{ id: 'format', selected: ['CSV'] }] })
    expect(await answer({ questions: [approval] }, next)).toEqual({ answers: [{ id: 'format', selected: ['CSV'] }] })
    expect(next).toHaveBeenCalledTimes(3)
  })
})

describe('elicit mode', () => {
  it('forwards the question with its detail and offered labels, then returns the accepted label', async () => {
    const { client: forwarding, elicit } = client({ action: 'accept', content: { decision: 'Always allow' } })
    const signal = new AbortController().signal
    expect(await elicitAnswer(forwarding, approval, signal)).toEqual({ id: 'cua-app-access', selected: ['Always allow'] })
    expect(elicit).toHaveBeenCalledWith(
      'Allow computer use to control Notes?\n\nThe session may read and operate the application.',
      ['Allow for this session', 'Deny', 'Always allow'], signal,
    )
    expect(await elicitAnswer(client({ action: 'accept', content: { decision: 'JSON' } }).client, generic, undefined))
      .toEqual({ id: 'format', selected: ['JSON'] })
  })

  it('maps decline to the rejecting label and cancel to a cancelled ask', async () => {
    expect(await elicitAnswer(client({ action: 'decline' }).client, approval, undefined)).toEqual({ id: 'cua-app-access', selected: ['Deny'] })
    await expect(elicitAnswer(client({ action: 'decline' }).client, generic, undefined)).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await expect(elicitAnswer(client({ action: 'cancel' }).client, approval, undefined)).rejects.toSatisfy(error =>
      error instanceof UserQuestionError && error.code === 'ASK_CANCELLED')
  })

  it('rejects an unoffered answer, a client without elicitation, and an unknown action', async () => {
    await expect(elicitAnswer(client({ action: 'accept', content: { decision: 'Maybe' } }).client, approval, undefined))
      .rejects.toThrow('without one of the offered answers')
    await expect(elicitAnswer(client({ action: 'accept' }).client, approval, undefined)).rejects.toThrow('without one of the offered answers')
    const { client: optionless, elicit } = client({ action: 'accept', content: { decision: 'yes' } })
    await expect(elicitAnswer(optionless, { id: 'free', question: 'Continue?' }, undefined)).rejects.toThrow('without one of the offered answers: []')
    expect(elicit).toHaveBeenCalledWith('Continue?', [], undefined)
    await expect(elicitAnswer(client({ action: 'accept' }, false).client, approval, undefined)).rejects.toThrow('DSH_CUA_CONSENT=allow')
    await expect(elicitAnswer(client({ action: 'later' as 'accept' }).client, approval, undefined)).rejects.toThrow('unknown elicitation action later')
  })

  it('answers every question of the connection Agent in order', async () => {
    const { client: forwarding, elicit } = client({ action: 'accept', content: { decision: 'Deny' } })
    elicit.mockResolvedValueOnce({ action: 'accept', content: { decision: 'Allow for this session' } })
      .mockResolvedValueOnce({ action: 'accept', content: { decision: 'CSV' } })
    const answer = createConsentAnswerer('elicit', candidate => candidate === agent, forwarding)
    const next = vi.fn(async () => { throw new Error('unexpected delegation') })
    expect(await answer({ questions: [approval, generic], agent }, next))
      .toEqual({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }, { id: 'format', selected: ['CSV'] }] })
    expect(next).not.toHaveBeenCalled()
  })
})
