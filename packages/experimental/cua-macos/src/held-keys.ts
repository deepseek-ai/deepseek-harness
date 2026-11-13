/** Directional input belongs to the enclosing program, including while its worker calls other tools. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CuaBackend } from '@deepseek-ai/dsh-cua'
import { NativeError, type NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import { RUN_CODE_NAME, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'

interface HeldKeyRun {
  id: string
  client?: NativeClient
  removeCleanup?: () => void
  released: boolean
  release(canRequest?: boolean): Promise<void>
}

/**
 * Keep native key ownership until program settlement or its Agent's native connection closes.
 * @param ctx - Provider scope owning the tool execution listener.
 * @returns Directional input handler; each native connection owns cleanup of the runs that use it.
 */
export function installHeldKeys(ctx: Context): NonNullable<CuaBackend['sendKeyEvent']> {
  const runs = new Map<ToolExecutionToken, HeldKeyRun>()
  ctx.on('tools/execute', async (execution, next) => {
    if (execution.name !== RUN_CODE_NAME && execution.name !== 'cua_run_code') return next()
    let cleanup: Promise<void> | undefined
    const run: HeldKeyRun = {
      id: randomUUID(), released: false,
      release(canRequest = true) {
        run.released = true
        return cleanup ??= Promise.resolve().then(async () => {
          try { if (canRequest) await run.client?.requestCleanup('releaseHeldKeys', { runId: run.id }) }
          finally { run.removeCleanup?.(); runs.delete(execution.token) }
        })
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
  return (client, params, execution) => {
    const run = execution.parent && runs.get(execution.parent)
    if (!run || run.released) throw new NativeError('INVALID_ARGUMENT', 'Use sendKeyEvent inside an active run_code or cua_run_code execution')
    if (run.client !== undefined && run.client !== client) {
      throw new NativeError('INVALID_ARGUMENT', 'The native connection changed; start a new program before holding keys')
    }
    if (run.client === undefined) {
      run.removeCleanup = client.registerCleanup(canRequest => run.release(canRequest))
      run.client = client
    }
    return client.request('sendKeyEvent', { ...params, runId: run.id }, execution.signal, execution.callId)
  }
}
