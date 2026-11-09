/** Directional input belongs to the enclosing program, including while its worker calls other tools. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CuaBackend } from '@deepseek-ai/dsh-cua'
import { NativeError, type NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import { RUN_CODE_NAME, type ToolExecution, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'

interface HeldKeyRun {
  id: string
  agent: ToolExecution['agent']
  client?: NativeClient
  released: boolean
  release(): Promise<void>
}

/**
 * Keep native key ownership until program settlement or its Agent's native connection closes.
 * @param ctx - Provider scope owning the tool execution listener.
 * @returns Directional input and Agent cleanup; cleanup releases keys without waiting for unrelated program code.
 */
export function installHeldKeys(ctx: Context): Required<Pick<CuaBackend, 'sendKeyEvent' | 'releaseInput'>> {
  const runs = new Map<ToolExecutionToken, HeldKeyRun>()
  ctx.on('tools/execute', async (execution, next) => {
    if (execution.name !== RUN_CODE_NAME && execution.name !== 'cua_run_code') return next()
    let cleanup: Promise<void> | undefined
    const run: HeldKeyRun = {
      id: randomUUID(), agent: execution.agent, released: false,
      release() {
        run.released = true
        return cleanup ??= (async () => {
          try { await run.client?.requestCleanup('releaseHeldKeys', { runId: run.id }) }
          finally { runs.delete(execution.token) }
        })()
      },
    }
    runs.set(execution.token, run)
    // Pause may arrive while an unrelated subtool is still settling.
    const onAbort = () => { void run.release().catch(() => undefined) }
    const signal = execution.signal
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await next()
    } finally {
      signal.removeEventListener('abort', onAbort)
      await run.release()
    }
  })
  return {
    sendKeyEvent(client, params, execution) {
      const run = execution.parent && runs.get(execution.parent)
      if (!run || run.released) throw new NativeError('INVALID_ARGUMENT', 'Use sendKeyEvent inside an active run_code or cua_run_code execution')
      run.client = client
      return client.request('sendKeyEvent', { ...params, runId: run.id }, execution.signal, execution.callId)
    },
    async releaseInput(agent) {
      const results = await Promise.allSettled([...runs.values()].filter(run => run.agent === agent).map(run => run.release()))
      const errors = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'Native held-key cleanup failed')
    },
  }
}
