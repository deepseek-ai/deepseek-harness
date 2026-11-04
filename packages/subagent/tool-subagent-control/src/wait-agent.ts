/** Input waiting owned by the subagent control plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Wait failures retain a stable machine-readable reason through tool execution. */
class AgentWaitError extends HarnessError {
  constructor(message: string, code: 'WAIT_INVALID_TIMEOUT' | 'WAIT_UNAVAILABLE') {
    super(message, code)
    this.name = 'AgentWaitError'
  }
}

/** Pending input ids that the latest successful wait of one model tool call reported. */
type ReportedInput = WeakMap<Agent, { readonly rootCallId: ToolCallId; readonly ids: ReadonlySet<MessageId> }>

/**
 * Wait without consuming input; every settlement removes its live resources.
 * Within one model tool call, such as a `run_code` program, pending input that
 * an earlier wait already reported does not end this wait: that input reaches
 * the model only after the call finishes, so a waiting loop cannot spin on it.
 */
function waitForInput(
  ctx: Context,
  agent: Agent,
  timeoutMs: number,
  signal: AbortSignal,
  lifetime: AbortSignal,
  reported: ReportedInput,
  rootCallId: ToolCallId,
): Promise<{ timedOut: boolean }> {
  lifetime.throwIfAborted()
  if (ctx.agents.get(agent.id) !== agent) {
    throw new AgentWaitError('wait_agent requires the exact live calling agent', 'WAIT_UNAVAILABLE')
  }
  const previous = reported.get(agent)
  const seen = previous?.rootCallId === rootCallId ? previous.ids : undefined
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
      const pending = agent.inbox.nextStep
      if (pending.some(message => seen?.has(message.id) !== true)) {
        reported.set(agent, { rootCallId, ids: new Set(pending.map(message => message.id)) })
        finish(() => { resolve({ timedOut: false }) })
      }
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
  const reported: ReportedInput = new WeakMap()
  ctx.effect(() => () => {
    lifetime.abort(new AgentWaitError('wait_agent ended because its plugin was unloaded', 'WAIT_UNAVAILABLE'))
  }, 'subagent-control.waits()')
  ctx.tools.register(defineTool({
    name: 'wait_agent',
    description: 'Wait for input at your next step, including agent messages, completion notifications, and user steering. Returns immediately if new input is pending. `timedOut: false` means new input is pending. Pending input is delivered to the model after code execution finishes.',
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
      return await waitForInput(ctx, exec.agent, timeoutMs, exec.signal, lifetime.signal, reported, exec.rootCallId)
    },
  }))
}
