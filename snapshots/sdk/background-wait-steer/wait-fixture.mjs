/**
 * Barrier that steers the model while its background wait is registered, then
 * checks the release, the surviving producer, and the single completion notice.
 *
 * Observations are collected in `tools/result`, which the tool runtime contains
 * (a throwing observer only logs), and asserted in `agent/turn-stopping`, whose
 * serial dispatch commits the turn — so a violated expectation fails the run.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['jobs', 'tools']

const STEER_TEXT = 'STEER_WHILE_WAITING'
const PRODUCER_OUTPUT = 'producer ready'
const STEERED_RESULT = 'producer ready\n[status: running, user steered]'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  let owner
  let id
  let steered = false
  let barrierError
  let released
  const originalWait = ctx.jobs.wait.bind(ctx.jobs)

  /**
   * Resolve once the producer's barrier line is in the job ring. `readAt` does
   * not advance the model cursor, so the released read still renders the line.
   * @param {string} jobId - the waited job.
   * @returns {Promise<void>} resolves after the producer's first write.
   */
  const whenProducerReady = async (jobId) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const read = ctx.jobs.readAt(jobId, 0, owner.id)
      if (read.chunks.some(chunk => chunk.channel !== 'log' && chunk.text.includes(PRODUCER_OUTPUT))) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('producer never wrote its barrier output')
  }

  ctx.effect(() => {
    ctx.jobs.wait = (...args) => {
      const pending = originalWait(...args)
      if (owner === undefined || steered) return pending
      steered = true
      id = args[0]
      // The registry registers its waiter before returning this promise, so the
      // steer below always lands on a live wait rather than a settled job.
      if (ctx.jobs.get(id, owner.id).status !== 'running') throw new Error('producer must be running at the waiter barrier')
      void whenProducerReady(id).then(
        () => owner.steer(createUserMessage({ content: [{ type: 'text', text: STEER_TEXT }], source: { kind: 'user' } })),
        (error) => { barrierError = error },
      )
      return pending
    }
    return () => { ctx.jobs.wait = originalWait }
  }, 'wait registration barrier')

  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'job_output' && owner === undefined) owner = exec.agent
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'job_output') return
    released = {
      isError: result.isError === true,
      text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
      producer: ctx.jobs.get(id, owner.id).status,
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== owner) return
    if (barrierError !== undefined) throw barrierError
    if (released === undefined) throw new Error('the steered wait returned no result')
    if (released.isError) throw new Error(`the steered wait failed: ${released.text}`)
    if (released.text !== STEERED_RESULT) throw new Error(`the steered wait returned ${JSON.stringify(released.text)}`)
    if (released.producer !== 'running') throw new Error('the released wait stopped the producer')
    const input = agent.session.deriveMessages()
      .find(message => message.role === 'user' && JSON.stringify(message.content).includes(STEER_TEXT))
    if (input === undefined) throw new Error('steer was not admitted for the next step')
    if (ctx.jobs.get(id, agent.id).status !== 'running') throw new Error('producer stopped before the steered step')
    const settled = Promise.withResolvers()
    const unsubscribe = ctx.jobs.events.subscribe({ owner: agent.id }, event => {
      if (event.type !== 'settled' || event.job.id !== id) return
      // The released read already answered the model; the completion notice it
      // withheld must still be delivered exactly once by this settlement.
      if (event.awaited) throw new Error('released waiter suppressed the completion notice')
      settled.resolve()
    })
    ctx.jobs.kill(id, agent.id, 'barrier teardown')
    await settled.promise
    unsubscribe()
    const notices = agent.inbox.nextStep.filter(message => message.source.kind === 'tool-jobs')
    if (notices.length !== 1) throw new Error(`expected exactly one completion notice, got ${notices.length}`)
    if (!JSON.stringify(notices[0].content).includes('finished')) throw new Error('completion notice does not report the settlement')
    agent.inbox.remove(notices[0].id)
  })
}
