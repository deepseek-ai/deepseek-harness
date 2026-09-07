import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  createInboxStub,
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
  unsupportedInbox,
} from '../src/index.ts'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('dsh-agent-loop-testkit', () => {
  it('rejects mutations through an unsupported Agent stub Inbox', () => {
    const inbox = unsupportedInbox()

    expect(inbox.nextTurn).toEqual([])
    expect(inbox.nextStep).toEqual([])
    expect(() => { inbox.clear() }).toThrow('this test Agent does not support Inbox mutations')
  })

  it('mounts a configurable prerequisite spine and the production AgentLoop', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { personaPrefix: 'Test persona.' },
      tools: { mode: 'native' },
    })

    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Test persona.')
    await expect(mountAgentLoopTestHarness(ctx)).resolves.toBeDefined()

    await ctx.fiber.dispose()
  })

  it('provides a mutable in-memory Inbox stub for structural Agent tests', () => {
    const inbox = createInboxStub()
    const firstTurn = message('first turn')
    const secondTurn = message('second turn')
    const firstStep = message('first step')
    const editedTurn = message('edited turn')
    const editedStep = message('edited step')

    inbox.append('next-turn', firstTurn)
    inbox.prepend('next-turn', secondTurn)
    inbox.append('next-step', firstStep)
    expect(inbox.nextTurn).toEqual([secondTurn, firstTurn])
    expect(inbox.nextStep).toEqual([firstStep])

    expect(inbox.replace(firstTurn.id, editedTurn)).toBe(true)
    expect(inbox.replace(firstStep.id, editedStep)).toBe(true)
    expect(inbox.replace(firstTurn.id, message('missing replacement'))).toBe(false)
    expect(inbox.remove(firstTurn.id)).toBe(false)
    expect(inbox.splice('next-turn', -1, 1, [])).toEqual([editedTurn])
    expect(inbox.remove(editedStep.id)).toBe(true)

    inbox.clear()
    expect(inbox.nextTurn).toEqual([])
    expect(inbox.nextStep).toEqual([])
  })

  it('drives durable Inbox behavior through a production Agent', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('agent-loop-testkit-inbox'))
    const turn = message('turn')
    const step = message('step')
    const inserted: string[] = []
    const claimed: Array<{ id: string; turn: number }> = []
    ctx.on('agent/inbox/inserted', ({ agent: subject, message: pending }) => {
      if (subject === agent) inserted.push(pending.id)
    })
    ctx.on('agent/inbox/claimed', ({ agent: subject, message: pending, turn: ownerTurn }) => {
      if (subject === agent) claimed.push({ id: pending.id, turn: ownerTurn })
    })

    agent.inbox.append('next-turn', turn)
    agent.inbox.append('next-step', step)

    expect(inserted).toEqual([turn.id, step.id])
    expect(() => { agent.inbox.append('next-step', turn) }).toThrow(`message "${turn.id}" is already pending`)
    const invalid = Session.create(SessionId('invalid-persisted-inbox'), [{
      type: 'agent/inbox/spliced',
      seq: SessionSeq(0),
      time: 1,
      data: { target: 'next-turn', start: 99, inserted: [] },
    }])
    expect(() => ctx.sessionProjections.stateOf(invalid, 'inbox'))
      .toThrow(/invalid persisted inbox splice/)
    expect(harness.claim(agent, 'next-turn', 3)).toEqual([step, turn])
    expect(claimed).toEqual([
      { id: step.id, turn: 3 },
      { id: turn.id, turn: 3 },
    ])
    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual([
      'agent/inbox/spliced',
      'agent/inbox/spliced',
      'agent/inbox/spliced',
      'agent/inbox/spliced',
    ])

    await ctx.fiber.dispose()
  })
})
