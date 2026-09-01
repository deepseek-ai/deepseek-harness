import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as commandGoal from '@deepseek-ai/dsh-command-goal'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build a live idle agent accepted by the exact-identity goal service. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  // Store-created: the command executor durably logs lifecycle events on it.
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Mount the real command registry, goal domain, and producer. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(GoalService)
  const plugin = await ctx.plugin(commandGoal)
  const { agent, session } = stubAgent(ctx, `command-goal-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, plugin }
}

/** The log with executor-owned command lifecycle bookkeeping stripped (goal assertions target domain events). */
function domainEvents(session: Session): readonly SessionEvent[] {
  const lifecycle = new Set<number>()
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'command/run' && event.type !== 'command/done') continue
    lifecycle.add(event.seq)
    // The zero-step wrap around a lifecycle event is bookkeeping too.
    const before = session.snapshotEvents()[event.seq - 1]
    const after = session.snapshotEvents()[event.seq + 1]
    if (before?.type === 'turn/start') lifecycle.add(before.seq)
    if (after?.type === 'turn/end') lifecycle.add(after.seq)
  }
  return session.snapshotEvents().filter(event => !lifecycle.has(event.seq))
}

/** Execute `/goal` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/goal${suffix}`,
    [],
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('goal command was not registered')
  return execution.result
}

/** Current exact compare-and-set ref. */
function ref(goal: NonNullable<ReturnType<GoalService['get']>>): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

describe('@deepseek-ai/dsh-command-goal registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandGoal.name).toBe('command-goal')
    expect(commandGoal.inject).toEqual(['commands', 'goals'])
    expect('default' in commandGoal).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandGoal)).toBe(commandGoal)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'goal',
      description: 'set or view the goal for a long-running task',
      input: { hint: '[<objective>|clear|edit <objective>|pause|resume]', images: true },
    })
    expect(test.ctx.commands.find(test.agent, 'goal')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'goal')).toBeUndefined()
  })
})

describe('/goal human command', () => {
  it('shows an empty status without mutating the session', async () => {
    const test = await harness()
    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: 'No goal is currently set.\nUsage: /goal [<objective>|clear|edit <objective>|pause|resume]',
    })
    expect(domainEvents(test.session)).toEqual([])
  })

  it('creates a trimmed objective and refuses silent replacement of unfinished work', async () => {
    const test = await harness()
    const created = await run(test, '\n  finish the release  ')
    expect(created.kind).toBe('success')
    expect(created.text).toContain('Goal created\nStatus: active')
    expect(created.text).toContain('Objective: finish the release')
    expect(created.text).toContain('Rounds: 0/256')
    expect(created.text).toContain('Activation: armed')
    expect(test.ctx.goals.get(test.agent)?.objective).toBe('finish the release')
    expect(domainEvents(test.session).map(event => event.type)).toEqual(['goal/change'])

    const count = domainEvents(test.session).length
    await expect(run(test, ' replacement')).resolves.toEqual({
      kind: 'error',
      text: 'A goal is already active. Use /goal edit <objective> to change it or /goal clear before replacing it.',
    })
    expect(domainEvents(test.session)).toHaveLength(count)
  })

  it('treats only exact control words as controls', async () => {
    const test = await harness()
    await run(test, ' pause everything only after verification')
    expect(test.ctx.goals.get(test.agent)?.objective).toBe('pause everything only after verification')
  })

  it('edits inline, requires an objective, and starts a new goal when the old one is complete', async () => {
    const empty = await harness()
    const invalidEdit = await run(empty, ' edit')
    expect(invalidEdit.kind).toBe('error')
    expect(invalidEdit.text).toContain('requires a replacement objective')
    const missingEdit = await run(empty, ' edit replacement')
    expect(missingEdit.kind).toBe('error')
    expect(missingEdit.text).toContain('/goal edit requires one')

    const test = await harness()
    await run(test, ' first')
    const first = test.ctx.goals.get(test.agent)!
    const updated = await run(test, ' EDIT\n  second  ')
    expect(updated.kind).toBe('success')
    expect(updated.text).toContain('Goal updated')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ id: first.id, objective: 'second', revision: 2 })

    const current = test.ctx.goals.get(test.agent)!
    test.ctx.goals.complete(test.agent, ref(current))
    const replacement = await run(test, ' edit third')
    expect(replacement.kind).toBe('success')
    expect(replacement.text).toContain('Goal created')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ objective: 'third', revision: 1 })
    expect(test.ctx.goals.get(test.agent)?.id).not.toBe(first.id)
  })

  it('returns direct missing-state results for pause, resume, and clear', async () => {
    const test = await harness()
    const missingPause = await run(test, ' pause')
    expect(missingPause.kind).toBe('error')
    expect(missingPause.text).toContain('/goal pause requires one')
    const missingResume = await run(test, ' resume')
    expect(missingResume.kind).toBe('error')
    expect(missingResume.text).toContain('/goal resume requires one')
    await expect(run(test, ' clear')).resolves.toEqual({ kind: 'success', text: 'No goal to clear.' })
  })

  it('pauses, resumes, clears, and converts expected domain rejections to command errors', async () => {
    const test = await harness()
    await run(test, ' work')
    const redundantResume = await run(test, ' RESUME')
    expect(redundantResume).toEqual({
      kind: 'error',
      text: 'The goal command is not valid for the current state. Run /goal to view available commands.',
    })
    const paused = await run(test, ' PAUSE')
    expect(paused.kind).toBe('success')
    expect(paused.text).toContain('Goal paused')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    const resumed = await run(test, ' resume')
    expect(resumed.kind).toBe('success')
    expect(resumed.text).toContain('Goal resumed')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    await expect(run(test, ' clear')).resolves.toEqual({ kind: 'success', text: 'Goal cleared.' })
    expect(test.ctx.goals.get(test.agent)).toBeUndefined()
  })

  it('shows every durable phase and distinguishes disarmed active state', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'state matrix', maxGoalRounds: 1 })
    test.ctx.goals.disarm(test.agent)
    expect((await run(test)).text)
      .toContain('Status: active\nObjective: state matrix\nRounds: 0/1\nActivation: disarmed')
    expect((await run(test)).text).toContain('/goal resume')

    let goal = test.ctx.goals.get(test.agent)!
    goal = test.ctx.goals.resume(test.agent, ref(goal))
    goal = test.ctx.goals.pause(test.agent, ref(goal))
    expect((await run(test)).text).toContain('Status: paused')

    goal = test.ctx.goals.resume(test.agent, ref(goal))
    goal = test.ctx.goals.block(test.agent, ref(goal), {
      code: 'upstream-unavailable',
      message: 'Provider unavailable',
    })
    const blocked = await run(test)
    expect(blocked.text).toContain('Status: blocked')
    expect(blocked.text).toContain('Blocker: upstream-unavailable: Provider unavailable')

    goal = test.ctx.goals.resume(test.agent, ref(goal))
    test.ctx.goals.complete(test.agent, ref(goal))
    const complete = await run(test)
    expect(complete.text).toContain('Status: complete')
    expect(complete.text).toContain('Commands: /goal <objective>, /goal clear')
  })

  it('does not turn unexpected implementation failures into expected command results', async () => {
    const test = await harness()
    vi.spyOn(test.ctx.goals, 'get').mockImplementationOnce(() => { throw new Error('unexpected failure') })
    await expect(run(test)).rejects.toThrow('unexpected failure')
  })
})

describe('/goal image attachments', () => {
  const PNG = 'AAAA'

  /** Wire the fake store the executor admits through (once per harness). */
  function provideStore(test: Harness): void {
    let saved = 0
    const saveImage = (input: { mediaType: string; name?: string }) => {
      saved += 1
      return Promise.resolve({
        attachmentId: `att-${saved}`, mediaType: input.mediaType, bytes: 3, width: 1, height: 1,
        ...input.name === undefined ? {} : { name: input.name },
      })
    }
    test.ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 1024,
        maxImagePixels: 1_000_000, mediaTypes: ['image/png'],
      },
      validateImage: () => Promise.resolve(),
      saveImage,
      async saveImages(inputs: readonly { mediaType: string; name?: string }[]) {
        const refs = []
        for (const input of inputs) refs.push(await saveImage(input))
        return refs
      },
    })
  }

  /** Run /goal with `count` composer images through the executor boundary. */
  async function runWithImages(test: Harness, suffix: string, count: number) {
    const images = Array.from({ length: count }, (_, index) => ({
      mediaType: 'image/png' as const, data: PNG, name: `ref-${index + 1}.png`,
    }))
    const execution = await test.ctx.commands.execute(test.agent, `/goal${suffix}`, images, new AbortController().signal)
    if (execution === undefined) throw new Error('goal command was not registered')
    return execution.result
  }

  it('submits one user followup carrying the admitted images ahead of the round prompt', async () => {
    const test = await harness()
    provideStore(test)
    const followup = vi.fn()
    ;(test.agent as unknown as { followup: typeof followup }).followup = followup
    const result = await runWithImages(test, ' rebuild the cathedral', 2)
    expect(result.kind).toBe('success')
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as {
      content: ReadonlyArray<Record<string, unknown>>
      source: { kind: string }
    }
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.content.map(block => block.type)).toEqual(['image', 'image', 'text'])
    expect(message.content.at(-1)).toEqual({ type: 'text', text: 'Reference images for the goal objective.' })
    expect((message.content[0] as { attachment: { name: string } }).attachment.name).toBe('ref-1.png')
  })

  it('accompanies an edit and a post-complete recreate the same way', async () => {
    const test = await harness()
    provideStore(test)
    const followup = vi.fn()
    ;(test.agent as unknown as { followup: typeof followup }).followup = followup
    test.ctx.goals.create(test.agent, { objective: 'initial objective' })
    const result = await runWithImages(test, ' edit refined objective', 1)
    expect(result.kind).toBe('success')
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('rejects attachments on sub-commands that cannot use them, leaving the domain untouched', async () => {
    const test = await harness()
    provideStore(test)
    const followup = vi.fn()
    ;(test.agent as unknown as { followup: typeof followup }).followup = followup
    test.ctx.goals.create(test.agent, { objective: 'active objective' })
    for (const suffix of [' pause', '', ' clear']) {
      const result = await runWithImages(test, suffix, 1)
      expect(result).toEqual({
        kind: 'error',
        text: 'Image attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.',
      })
    }
    expect(followup).not.toHaveBeenCalled()
    expect(test.ctx.goals.get(test.agent)?.phase).toBe('active')
  })

  it('does not submit attachments when goal creation is refused', async () => {
    const test = await harness()
    provideStore(test)
    const followup = vi.fn()
    ;(test.agent as unknown as { followup: typeof followup }).followup = followup
    test.ctx.goals.create(test.agent, { objective: 'existing objective' })
    const result = await runWithImages(test, ' replacement objective', 1)
    expect(result.kind).toBe('error')
    expect(followup).not.toHaveBeenCalled()
  })
})
