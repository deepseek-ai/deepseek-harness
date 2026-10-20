/**
 * Delivery from outside an Agent: `ctx.agentController.deliver` prepares the
 * message content, asks the `agent-controller/admission` listeners for a
 * decision, then appends an admitted message, one message per Agent at a time.
 */

import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentController, { ADMISSION_AGENT_GONE, ADMISSION_FAILED, AgentAdmissionRejected } from '@deepseek-ai/dsh-agent-controller'
import type { DeliveryMode, DeliveryRequest } from '@deepseek-ai/dsh-agent-controller'

/** One message the Agent received through `followup` or `steer`. */
interface Delivery {
  readonly mode: DeliveryMode
  readonly text: string
  readonly id: string
}

/** An inbox delivery never touches directly: messages enter through `followup` and `steer`. */
function untouchedInbox(): Inbox {
  const refuse = (): never => {
    throw new Error('delivery must enter through followup or steer')
  }
  return {
    nextTurn: [], nextStep: [], clear: refuse, append: refuse, prepend: refuse, replace: refuse, remove: refuse, splice: refuse,
  }
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** A sender that stays connected. */
function connected(): AbortSignal {
  return new AbortController().signal
}

/** A followup whose prepared content is one text block. */
function request(text: string, overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    mode: 'followup',
    source: { kind: 'user' },
    signal: connected(),
    prepare: () => Promise.resolve([{ type: 'text', text }]),
    ...overrides,
  }
}

/** A preparation that records its text, then returns it as the message content. */
function recordingPrepare(prepared: string[], text: string): DeliveryRequest['prepare'] {
  return () => {
    prepared.push(text)
    return Promise.resolve([{ type: 'text', text }])
  }
}

/** Let pending deliveries run as far as they can. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/** The rejection of a delivery that must fail. */
async function refusalOf(delivery: Promise<unknown>): Promise<unknown> {
  return await delivery.then(() => { throw new Error('the message was delivered') }, (error: unknown) => error)
}

async function harness(): Promise<{
  ctx: Context
  controller: AgentController
  disposeController: () => Promise<void>
  agent: Agent
  delivered: Delivery[]
  recordingAgent: (rawId: string, deliveries: Delivery[], refusal?: Error) => Promise<{ agent: Agent; dispose: () => Promise<void> }>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const controllerFiber = await ctx.plugin(AgentController)
  const recordingAgent = async (rawId: string, deliveries: Delivery[], refusal?: Error) => {
    const id = SessionId(rawId)
    const receive = (mode: DeliveryMode, received: UserMessage): void => {
      if (refusal !== undefined) throw refusal
      deliveries.push({ mode, text: textOf(received), id: received.id })
    }
    const agent: Agent = {
      id,
      options: {},
      session: Session.create(id),
      inbox: untouchedInbox(),
      status: 'idle',
      ctx,
      send: () => {},
      followup: (received) => { receive('followup', received) },
      steer: (received) => { receive('steer', received) },
      inject: () => {},
      cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    const unregister = await ctx.agents.register(agent)
    return { agent, dispose: async () => { await unregister() } }
  }
  const delivered: Delivery[] = []
  const { agent, dispose } = await recordingAgent('delivery-agent', delivered)
  return {
    ctx,
    controller: ctx.agentController,
    disposeController: async () => { await controllerFiber.dispose() },
    agent,
    delivered,
    recordingAgent,
    dispose,
  }
}

describe('agent controller delivery', () => {
  it('appends the prepared message with followup or steer only after every listener, in registration order, admitted it', async () => {
    const { ctx, agent, delivered } = await harness()
    const unwatched = await ctx.agentController.deliver(agent, request('unwatched', { source: { kind: 'schedule' } }))
    expect(delivered).toEqual([{ mode: 'followup', text: 'unwatched', id: unwatched }])

    const order: string[] = []
    ctx.on('agent-controller/admission', async ({ agent: subject, message }, next) => {
      expect(subject).toBe(agent)
      expect(message.source).toEqual({ kind: 'user' })
      order.push(`first ${textOf(message)}`)
      const decision = await next()
      order.push(`first got ${decision.kind} with ${String(delivered.length)} delivered`)
      return decision
    })
    ctx.on('agent-controller/admission', async (_admission, next) => {
      order.push('second')
      return await next()
    })
    const steered = await ctx.agentController.deliver(agent, request('steered', { mode: 'steer' }))
    expect(order).toEqual(['first steered', 'second', 'first got admit with 1 delivered'])
    expect(delivered).toEqual([
      { mode: 'followup', text: 'unwatched', id: unwatched },
      { mode: 'steer', text: 'steered', id: steered },
    ])
  })

  it('holds a message until its listener passes it on, keeping later messages to that Agent behind it, preparation included', async () => {
    const { ctx, agent, delivered, recordingAgent } = await harness()
    const other: Delivery[] = []
    const { agent: otherAgent } = await recordingAgent('other-agent', other)
    const release = Promise.withResolvers<undefined>()
    const prepared: string[] = []
    const seen: string[] = []
    ctx.on('agent-controller/admission', async ({ message }, next) => {
      seen.push(textOf(message))
      if (textOf(message) === 'first') await release.promise
      return await next()
    })
    const prepareText = (text: string): DeliveryRequest['prepare'] => recordingPrepare(prepared, text)

    const first = ctx.agentController.deliver(agent, request('first', { prepare: prepareText('first') }))
    const second = ctx.agentController.deliver(agent, request('second', { prepare: prepareText('second') }))
    await ctx.agentController.deliver(otherAgent, request('elsewhere', { prepare: prepareText('elsewhere') }))
    await settle()
    expect(prepared).toEqual(['first', 'elsewhere'])
    expect(seen).toEqual(['first', 'elsewhere'])
    expect(delivered).toEqual([])
    expect(other.map(delivery => delivery.text)).toEqual(['elsewhere'])

    release.resolve(undefined)
    await Promise.all([first, second])
    expect(prepared).toEqual(['first', 'elsewhere', 'second'])
    expect(delivered.map(delivery => delivery.text)).toEqual(['first', 'second'])
  })

  it('rejects a message with the decision of a listener, skips later listeners, and delivers the next message', async () => {
    const { ctx, agent, delivered } = await harness()
    let reject = true
    let later = 0
    ctx.on('agent-controller/admission', async (_admission, next) => {
      if (reject) return { kind: 'reject', reason: 'fixture/missing', message: 'The fixture is missing.', presented: true }
      return await next()
    })
    ctx.on('agent-controller/admission', async (_admission, next) => {
      later += 1
      return await next()
    })

    const refusal = await refusalOf(ctx.agentController.deliver(agent, request('refused')))
    expect(refusal).toBeInstanceOf(AgentAdmissionRejected)
    expect(refusal).toMatchObject({
      name: 'AgentAdmissionRejected',
      code: 'AGENT_ADMISSION_REJECTED',
      reason: 'fixture/missing',
      presented: true,
      message: 'The fixture is missing.',
    })
    expect(delivered).toEqual([])
    expect(later).toBe(0)

    reject = false
    await ctx.agentController.deliver(agent, request('admitted'))
    expect(delivered.map(delivery => delivery.text)).toEqual(['admitted'])
    expect(later).toBe(1)
  })

  it.each([
    ['before it passes the message on', false],
    ['after the rest of the chain admitted the message', true],
  ])('rejects a message whose listener throws %s as a failed check', async (_label, afterNext) => {
    const { ctx, agent, delivered } = await harness()
    const broken = new Error('listener broke')
    ctx.on('agent-controller/admission', async (_admission, next) => {
      if (afterNext) await next()
      throw broken
    })

    const refusal = await refusalOf(ctx.agentController.deliver(agent, request('broken')))
    expect(refusal).toMatchObject({ code: 'AGENT_ADMISSION_REJECTED', reason: ADMISSION_FAILED, presented: false, cause: broken })
    expect(refusal).toHaveProperty('message', expect.stringContaining('listener broke'))
    expect(delivered).toEqual([])
  })

  it('passes the failure of preparation to the sender unchanged without asking a listener', async () => {
    const { ctx, agent, delivered } = await harness()
    const unreadable = new Error('attachment unreadable')
    let asked = 0
    ctx.on('agent-controller/admission', async (_admission, next) => {
      asked += 1
      return await next()
    })

    await expect(ctx.agentController.deliver(agent, request('unreadable', { prepare: () => Promise.reject(unreadable) })))
      .rejects.toBe(unreadable)
    expect(asked).toBe(0)
    expect(delivered).toEqual([])
  })

  it('runs beforeInsert with the admitted message right before it enters the inbox, and keeps the message out when it throws', async () => {
    const { ctx, agent, delivered } = await harness()
    const observed: { readonly text: string; readonly deliveredBefore: number }[] = []
    const id = await ctx.agentController.deliver(agent, request('recorded', {
      beforeInsert: (message) => { observed.push({ text: textOf(message), deliveredBefore: delivered.length }) },
    }))
    expect(observed).toEqual([{ text: 'recorded', deliveredBefore: 0 }])
    expect(delivered).toEqual([{ mode: 'followup', text: 'recorded', id }])

    const unbound = new Error('upload binding failed')
    await expect(ctx.agentController.deliver(agent, request('unbound', { beforeInsert: () => { throw unbound } })))
      .rejects.toBe(unbound)
    expect(delivered.map(delivery => delivery.text)).toEqual(['recorded'])
  })

  it('passes the refusal of the Agent itself to queue a message to the sender unchanged', async () => {
    const { ctx, recordingAgent } = await harness()
    const full = new Error('inbox refused the message')
    const { agent: refusing } = await recordingAgent('refusing-agent', [], full)

    await expect(ctx.agentController.deliver(refusing, request('overflow', { mode: 'steer' }))).rejects.toBe(full)
  })

  it('rejects a message whose Agent left the registry while a listener held it', async () => {
    const { ctx, agent, delivered, dispose } = await harness()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent-controller/admission', async (_admission, next) => {
      await release.promise
      return await next()
    })

    const pending = refusalOf(ctx.agentController.deliver(agent, request('orphaned')))
    await settle()
    await dispose()
    release.resolve(undefined)
    expect(await pending).toMatchObject({ code: 'AGENT_ADMISSION_REJECTED', reason: ADMISSION_AGENT_GONE, presented: false })
    expect(delivered).toEqual([])
  })

  it('rejects a message whose Agent left the registry before its turn without preparing it', async () => {
    const { ctx, agent, delivered, dispose } = await harness()
    const release = Promise.withResolvers<undefined>()
    let prepared = false
    ctx.on('agent-controller/admission', async (_admission, next) => {
      await release.promise
      return await next()
    })

    const blocking = refusalOf(ctx.agentController.deliver(agent, request('blocking')))
    const waiting = refusalOf(ctx.agentController.deliver(agent, request('waiting', {
      prepare: () => {
        prepared = true
        return Promise.resolve([{ type: 'text', text: 'waiting' }])
      },
    })))
    await settle()
    await dispose()
    release.resolve(undefined)
    expect(await blocking).toMatchObject({ reason: ADMISSION_AGENT_GONE })
    expect(await waiting).toMatchObject({ reason: ADMISSION_AGENT_GONE })
    expect(prepared).toBe(false)
    expect(delivered).toEqual([])
  })

  it('stops a message its sender cancels while a listener holds it, while it waits for its turn, during preparation, or before it is appended', async () => {
    const { ctx, agent, delivered } = await harness()
    const release = Promise.withResolvers<undefined>()
    const unheeded = Promise.withResolvers<undefined>()
    const seen: string[] = []
    ctx.on('agent-controller/admission', async ({ message, signal }, next) => {
      seen.push(textOf(message))
      if (textOf(message) === 'blocking') await release.promise
      // A listener that ignores the sender's signal still cannot append a cancelled message.
      if (textOf(message) === 'unheeded') await unheeded.promise
      if (textOf(message) === 'held') {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
        })
      }
      return await next()
    })

    const heldSender = new AbortController()
    const held = ctx.agentController.deliver(agent, request('held', { signal: heldSender.signal }))
    await settle()
    const heldReason = new Error('held sender left')
    heldSender.abort(heldReason)
    await expect(held).rejects.toBe(heldReason)

    const blocking = ctx.agentController.deliver(agent, request('blocking'))
    const waitingSender = new AbortController()
    const waiting = ctx.agentController.deliver(agent, request('waiting', { signal: waitingSender.signal }))
    const waitingReason = new Error('waiting sender left')
    waitingSender.abort(waitingReason)
    release.resolve(undefined)
    await blocking
    await expect(waiting).rejects.toBe(waitingReason)

    const preparingSender = new AbortController()
    const preparingReason = new Error('preparing sender left')
    const preparing = ctx.agentController.deliver(agent, request('preparing', {
      signal: preparingSender.signal,
      prepare: () => {
        preparingSender.abort(preparingReason)
        return Promise.resolve([{ type: 'text', text: 'preparing' }])
      },
    }))
    await expect(preparing).rejects.toBe(preparingReason)

    const unheededSender = new AbortController()
    const ignored = ctx.agentController.deliver(agent, request('unheeded', { signal: unheededSender.signal }))
    await settle()
    const unheededReason = new Error('unheeded sender left')
    unheededSender.abort(unheededReason)
    unheeded.resolve(undefined)
    await expect(ignored).rejects.toBe(unheededReason)

    expect(seen).toEqual(['held', 'blocking', 'unheeded'])
    expect(delivered.map(delivery => delivery.text)).toEqual(['blocking'])
  })

  it('ends the wait of a message whose sender cancels behind a held one, keeping later messages in order', async () => {
    const { ctx, agent, delivered } = await harness()
    const release = Promise.withResolvers<undefined>()
    const prepared: string[] = []
    ctx.on('agent-controller/admission', async ({ message, signal }, next) => {
      if (textOf(message) === 'held') {
        // Holds until released, and lets a stopping controller end the hold.
        await new Promise<void>((resolve, reject) => {
          void release.promise.then(() => { resolve() })
          signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
        })
      }
      return await next()
    })
    const prepareText = (text: string): DeliveryRequest['prepare'] => recordingPrepare(prepared, text)

    const held = ctx.agentController.deliver(agent, request('held', { prepare: prepareText('held') }))
    const queuedSender = new AbortController()
    const queued = refusalOf(ctx.agentController.deliver(agent, request('queued', {
      signal: queuedSender.signal, prepare: prepareText('queued'),
    })))
    const goneSender = new AbortController()
    const goneReason = new Error('sender left before delivering')
    goneSender.abort(goneReason)
    const gone = refusalOf(ctx.agentController.deliver(agent, request('gone', {
      signal: goneSender.signal, prepare: prepareText('gone'),
    })))
    const later = ctx.agentController.deliver(agent, request('later', { prepare: prepareText('later') }))
    await settle()
    const queuedReason = new Error('queued sender left')
    queuedSender.abort(queuedReason)
    // Both senders hear their own reason while the held message still blocks the Agent.
    expect(await Promise.race([queued, settle().then(() => 'still waiting')])).toBe(queuedReason)
    expect(await gone).toBe(goneReason)
    expect(prepared).toEqual(['held'])

    release.resolve(undefined)
    await Promise.all([held, later])
    expect(prepared).toEqual(['held', 'later'])
    expect(delivered.map(delivery => delivery.text)).toEqual(['held', 'later'])
  })

  it('finishes disposal only after the deliveries it stopped have settled', async () => {
    const { ctx, controller, disposeController, agent, delivered } = await harness()
    const cleanup = Promise.withResolvers<undefined>()
    const steps: string[] = []
    ctx.on('agent-controller/admission', async ({ signal }, next) => {
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      steps.push('stop observed')
      await cleanup.promise
      steps.push('cleaned up')
      return await next()
    })

    const held = refusalOf(controller.deliver(agent, request('held')))
    await settle()
    let disposed = false
    const disposal = disposeController().then(() => { disposed = true })
    await settle()
    expect(steps).toEqual(['stop observed'])
    expect(disposed).toBe(false)

    cleanup.resolve(undefined)
    await disposal
    expect(steps).toEqual(['stop observed', 'cleaned up'])
    expect(await held).toHaveProperty('message', expect.stringContaining('agent controller stopped'))
    expect(delivered).toEqual([])
  })

  it('stops every message that has not entered the inbox when the controller is disposed', async () => {
    const { ctx, controller, disposeController, agent, delivered } = await harness()
    const seen: string[] = []
    ctx.on('agent-controller/admission', async ({ message, signal }, next) => {
      seen.push(textOf(message))
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
      })
      return await next()
    })

    const held = refusalOf(controller.deliver(agent, request('held')))
    const waiting = refusalOf(controller.deliver(agent, request('waiting')))
    await settle()
    await disposeController()

    for (const refusal of [await held, await waiting, await refusalOf(controller.deliver(agent, request('late')))]) {
      expect(refusal).toHaveProperty('message', expect.stringContaining('agent controller stopped'))
    }
    expect(seen).toEqual(['held'])
    expect(delivered).toEqual([])
  })
})
