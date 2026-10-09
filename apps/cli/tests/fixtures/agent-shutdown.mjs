/** Scope-owned cancellation during shutdown of the shipped Web profile. */
import { existsSync, writeFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'agent-shutdown-fixture'
export const inject = ['agents', 'llm', 'appReady', 'appExit']

class Adapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async *stream() {
    throw new Error('The cancelled request must not reach the adapter.')
  }
}

/** Hold one turn until cancellation and report the state seen by scope cleanup. */
export function apply(ctx, config) {
  ctx.llm.registerAdapter(['shutdown-fixture'], new Adapter())
  const exit = ctx.appExit
  ctx.effect(() => ctx.appReady.onReady(() => {
    void start(ctx, config).catch(error => { console.error(error); exit(1) })
  }))
  if (process.platform === 'win32') {
    const timer = setInterval(() => {
      if (!existsSync(config.interrupt)) return
      clearInterval(timer)
      process.emit('SIGTERM')
    }, 20)
    ctx.effect(() => () => { clearInterval(timer) })
  }
}

async function start(ctx, config) {
  const { agent } = await ctx.agents.create({
    sessionId: 'shutdown-fixture',
    agentOptions: { provider: 'shutdown-fixture', model: 'shutdown-fixture' },
    meta: { cwd: config.root },
  })
  const controller = new AbortController()
  let abortHandled = 0
  controller.signal.addEventListener('abort', () => {
    agent.cancel({ kind: 'parent' })
    agent.cancel({ kind: 'parent' })
    abortHandled++
  }, { once: true })
  agent.ctx.effect(() => () => {
    controller.abort()
    controller.abort()
    const events = agent.session.snapshotEvents()
    writeFileSync(config.result, JSON.stringify({
      abortHandled,
      status: agent.status,
      nextStep: agent.inbox.nextStep,
      nextTurn: agent.inbox.nextTurn,
      lastEvent: events.at(-1),
      cancelled: events.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'),
    }))
  })
  const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  if (config.running) {
    const entered = Promise.withResolvers()
    agent.ctx.on('agent/request', async ({ signal }, next) => {
      const aborted = Promise.withResolvers()
      signal.addEventListener('abort', () => { aborted.resolve() }, { once: true })
      entered.resolve()
      await aborted.promise
      await setImmediate()
      return next()
    })
    agent.followup(message('active'))
    await entered.promise
  }
  agent.send(message('pending step'), 'next-step', false)
  agent.send(message('pending turn'), 'next-turn', false)
  if (config.cancelFirst) {
    controller.abort()
    await agent.whenIdle()
  }
  console.log('agent-shutdown: ready')
}
