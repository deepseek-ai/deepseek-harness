/** Input waiting owned by the subagent control plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Wait failures retain a stable machine-readable reason through tool execution. */
class AgentWaitError extends HarnessError {
  constructor(message: string, code: 'WAIT_INVALID_TIMEOUT' | 'WAIT_UNAVAILABLE') {
    super(message, code)
    this.name = 'AgentWaitError'
  }
}

/** Wait without consuming input; every settlement removes its live resources. */
function waitForInput(
  ctx: Context,
  agent: Agent,
  timeoutMs: number,
  signal: AbortSignal,
  lifetime: AbortSignal,
): Promise<{ timedOut: boolean }> {
  lifetime.throwIfAborted()
  if (ctx.agents.get(agent.id) !== agent) {
    throw new AgentWaitError('wait_agent requires the exact live calling agent', 'WAIT_UNAVAILABLE')
  }
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void): void => {
      clearTimeout(timer)
      offInbox()
      offDisposed()
      signal.removeEventListener('abort', onAbort)
      lifetime.removeEventListener('abort', onUnload)
      settle()
    }
    const onInput = (): void => {
      if (agent.inbox.nextStep.length > 0) finish(() => { resolve({ timedOut: false }) })
    }
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Cancellation preserves the caller's exact AbortSignal reason.
    const onAbort = (): void => { finish(() => { reject(signal.reason) }) }
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- This plugin aborts its lifetime only with AgentWaitError.
    const onUnload = (): void => { finish(() => { reject(lifetime.reason) }) }
    const offInbox = ctx.on('agent/inbox/inserted', ({ agent: recipient }) => {
      if (recipient === agent) onInput()
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent: disposed }) => {
      if (disposed === agent) {
        finish(() => {
          reject(new AgentWaitError('wait_agent ended because the calling agent was disposed', 'WAIT_UNAVAILABLE'))
        })
      }
    })
    signal.addEventListener('abort', onAbort, { once: true })
    lifetime.addEventListener('abort', onUnload, { once: true })
    const timer = setTimeout(() => { finish(() => { resolve({ timedOut: true }) }) }, timeoutMs)
    // Subscribe before reading pending input so an arrival cannot fall between them.
    if (signal.aborted) onAbort()
    else onInput()
  })
}

/**
 * Register one inbox wait tool and cancel its waits when the plugin unloads.
 * @param ctx - plugin context owning the tool, event listeners, and wait lifetime.
 */
export function registerWaitAgent(ctx: Context): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => {
    lifetime.abort(new AgentWaitError('wait_agent ended because its plugin was unloaded', 'WAIT_UNAVAILABLE'))
  }, 'subagent-control.waits()')
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description: 'Wait for input at your next step, including agent messages, completion notifications, and user steering. Returns immediately when that input is already pending.',
    parameters: {
      timeout_ms: {
        type: 'integer',
        description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { timedOut: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const timeoutMs = args.timeout_ms ?? 30_000
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
        throw new AgentWaitError('timeout_ms must be an integer from 10000 through 3600000', 'WAIT_INVALID_TIMEOUT')
      }
      if (exec.agent === undefined) {
        throw new AgentWaitError('wait_agent requires a calling agent', 'WAIT_UNAVAILABLE')
      }
      return await waitForInput(ctx, exec.agent, timeoutMs, exec.signal, lifetime.signal)
    },
  }))
}
