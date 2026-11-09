/** Directional input belongs to the enclosing run_code, including while its worker calls other tools. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CuaBackend } from '@deepseek-ai/dsh-cua'
import { NativeError, type NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import { RUN_CODE_NAME, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'

/**
 * Keep native key ownership alive until its program returns, throws, or is interrupted.
 * @param ctx - Provider scope owning the tool execution listener.
 * @returns Handler for authorized directional keyboard requests.
 */
export function installHeldKeys(ctx: Context): NonNullable<CuaBackend['sendKeyEvent']> {
  const runs = new Map<ToolExecutionToken, { id: string; client?: NativeClient }>()
  ctx.on('tools/execute', async (execution, next) => {
    if (execution.name !== RUN_CODE_NAME) return next()
    const run: { id: string; client?: NativeClient } = { id: randomUUID() }
    runs.set(execution.token, run)
    let cleanup: Promise<unknown> | undefined
    const release = () => {
      runs.delete(execution.token)
      if (run.client) cleanup ??= run.client.requestCleanup('releaseHeldKeys', { runId: run.id })
      return cleanup
    }
    // Pause may arrive while an unrelated subtool is still settling.
    const onAbort = () => { void release()?.catch(() => undefined) }
    const signal = execution.signal
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await next()
    } finally {
      signal.removeEventListener('abort', onAbort)
      await release()
    }
  })
  return (client, params, execution) => {
    const run = execution.parent && runs.get(execution.parent)
    if (!run) throw new NativeError('INVALID_ARGUMENT', 'Use sendKeyEvent inside an active run_code execution')
    run.client = client
    return client.request('sendKeyEvent', { ...params, runId: run.id }, execution.signal, execution.callId)
  }
}
