import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'subagent-durability-failure'
export const inject = ['agents', 'sessionPersistence', 'subagents']

/**
 * The authored parent transcript names the background child by a stable
 * placeholder id, but the live continuable child is minted with a fresh random
 * session id at run time. This snapshot-only overlay bridges that gap and forces
 * deterministic ordering plus authored child durability failures:
 *
 *  - `PLACEHOLDER_CHILD_ID` in a scripted `send_message` is remapped to the real
 *    child so both follow-ups queue onto the same live inbox in FIFO order.
 *  - The unknown-id `send_message` (`UNKNOWN_CHILD_ID`) resolves through a
 *    persistence load fenced behind both accepted follow-ups, so the transcript
 *    records the same order on every runner.
 *  - The child's final continuation turn fails its durability checkpoint with a
 *    fixed message, so the scenario proves child-first disposal survives a failed
 *    last flush.
 *  - Under `DSH_SUBAGENT_PUBLISHED_FAILURE`, a one-shot child's first
 *    follow-up fails after publication, so its model prompt never runs; its
 *    published handle then also fails disposal, so the parent observes both
 *    independent failures.
 */
const PLACEHOLDER_CHILD_ID = '33333333-3333-4333-8333-333333333333'
const UNKNOWN_CHILD_ID = '22222222-2222-4222-8222-222222222222'
/** The child continuation turn whose durability checkpoint is forced to fail. */
const FAILED_CHECKPOINT_TURN = 3

/** Fail the child checkpoint and stabilize the authored follow-up failure ordering. */
export function apply(ctx: Context): void {
  const followupsAccepted = Promise.withResolvers<undefined>()
  const parentTurnClosed = Promise.withResolvers<undefined>()
  let parentClosed = false
  const publishedFailure = process.env.DSH_SUBAGENT_PUBLISHED_FAILURE === '1'
  const persistence = ctx.sessionPersistence
  const load = persistence.load.bind(persistence)
  const agents = ctx.agents
  const create = agents.create.bind(agents)

  agents.create = async (options) => {
    const handle = await create(options)
    if (!publishedFailure || options.meta?.parentSession === undefined) return handle
    handle.agent.followup = () => {
      throw new Error('snapshot published run failed')
    }
    return {
      ...handle,
      async dispose() {
        await handle.dispose()
        throw new Error('snapshot published handle disposal failed')
      },
    }
  }

  // The unavailable-child lookup is real asynchronous I/O. Fence it behind both
  // authored follow-ups so runner speed cannot reorder the exact log.
  persistence.load = async (id) => {
    if (id === UNKNOWN_CHILD_ID) await followupsAccepted.promise
    return load.call(persistence, id)
  }
  ctx.effect(() => () => {
    agents.create = create
    persistence.load = load
    followupsAccepted.resolve(undefined)
    parentTurnClosed.resolve(undefined)
  }, 'subagent snapshot ordering')

  // The manager's settlement notice races whatever the parent is doing when the
  // child's Activation ends, and this transcript pins it as the parent's own
  // later turn. Hold the child's steps until the parent's spawn turn closes, so
  // the notice can only arrive at an idle parent. The parent's turn never awaits
  // child model work — its own fences need inbox acceptance only — so the child
  // cannot deadlock it.
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession !== undefined || event.type !== 'turn/end') return
    if (event.data.turn !== 1) return
    parentClosed = true
    parentTurnClosed.resolve(undefined)
  })

  // Remap the placeholder child id in a follow-up to the live child. The child
  // id the model "knows" is authored into the transcript, while the running
  // child is minted with a random id, so without this the follow-ups would
  // never reach the live inbox.
  let realChildId: string | undefined
  const subagents = ctx.subagents as unknown as {
    sendMessage: (authority: unknown, childId: SessionId, content: unknown, options: unknown) => Promise<unknown>
  }
  const deliver = subagents.sendMessage.bind(subagents)
  subagents.sendMessage = (authority, childId, content, options) => {
    const mapped = childId === PLACEHOLDER_CHILD_ID && realChildId !== undefined
      ? SessionId(realChildId)
      : childId
    return deliver(authority, mapped, content, options)
  }

  // Both authored follow-ups reach the child inbox before the unknown-id lookup
  // runs, so the queued FIFO order is what the transcript records. The first
  // child enqueue is the initial delegation, which also pins the real child id.
  let accepted = 0
  ctx.on('agent/inbox/inserted', ({ agent }) => {
    if (agent.session.header.parentSession === undefined) return
    if (realChildId === undefined) realChildId = agent.session.header.id
    accepted += 1
    if (accepted >= 3) followupsAccepted.resolve(undefined)
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.session.header.parentSession === undefined) return next()
    await followupsAccepted.promise
    // The published-failure variant's child never reaches a step (its follow-up
    // throws), and its parent turn awaits that child, so only the continuable
    // scenario takes the settlement fence.
    if (!publishedFailure && !parentClosed) await parentTurnClosed.promise
    return next()
  })

  // The child's ordinary per-turn flushes succeed; only the final continuation
  // turn's durability checkpoint fails, turning that turn/end into a durable
  // error the parent never sees.
  const childTurn = new WeakMap<object, number>()
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === undefined || event.type !== 'turn/start') return
    childTurn.set(session, event.data.turn)
  })
  ctx.on('session/flush', (session) => {
    if (session.header.parentSession === undefined) return
    if (childTurn.get(session) === FAILED_CHECKPOINT_TURN) throw new Error('snapshot disk full')
  })
}
