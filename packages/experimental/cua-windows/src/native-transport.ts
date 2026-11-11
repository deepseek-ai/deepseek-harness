/** Direct Windows pipes and WSL subprocess streams for the same native protocol. */
import { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import assert from 'node:assert/strict'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { NativeError, type NativeClientConfig } from '@deepseek-ai/dsh-cua/native-client'

/** Transport selected from the resolved Host environment. */
export type WindowsTransport = 'pipe' | 'stdio'

/** One connection owns its stream and, for WSL, a Windows bridge process. */
export interface WindowsConnection {
  stream: Duplex
  connected: Promise<void>
  dispose(): Promise<void>
}

/**
 * Connect to a Windows desktop service without exposing a network listener.
 * @param subprocess Managed process owner for the WSL bridge.
 * @param config Helper executable and connection/cleanup limits.
 * @param endpoint Named pipe reported by the verified service lease.
 * @param runtimeKey Expected executable digest, verified again by the Windows bridge.
 * @param transport Native pipe or standard streams through WSL interoperation.
 * @returns Owned connection; disposal joins the bridge process after stream closure.
 */
export function connectWindowsPipe(subprocess: Pick<SubprocessRuntime, 'spawn'>, config: NativeClientConfig,
  endpoint: string, runtimeKey: string, transport: WindowsTransport): WindowsConnection {
  if (transport === 'pipe') {
    const stream = new Socket()
    const connected = new Promise<void>((resolve, reject) => {
      stream.once('connect', resolve)
      stream.once('error', reject)
    })
    void connected.catch(() => {})
    stream.connect(endpoint)
    return { stream, connected, dispose: async () => {} }
  }
  const handle = subprocess.spawn({
    argv: [config.helperPath, '--bridge', '--runtime-key', runtimeKey,
      '--connect-timeout-ms', String(config.connectTimeoutMs), '--grace-ms', String(config.graceMs)],
    cwd: config.cwd, graceMs: config.graceMs,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65_536 } },
  })
  assert(handle.stdin && handle.stdout, 'The Windows bridge requires standard input and output')
  const stream = Duplex.from({ readable: handle.stdout, writable: handle.stdin })
  stream.once('end', () => { stream.end() })
  void handle.done.then((outcome) => {
    if (outcome.exitCode !== 0 || outcome.signal !== null)
      stream.destroy(new NativeError('NATIVE_EXITED', `Windows bridge failed: ${handle.collected.stderr?.readFrom(0).text ?? String(outcome.exitCode)}`))
  }, (error: unknown) => { stream.destroy(error instanceof Error ? error : new Error(String(error))) })
  return {
    stream, connected: Promise.resolve(),
    async dispose() {
      handle.stdin?.end()
      const timer = setTimeout(() => { handle.terminate() }, config.graceMs)
      try {
        const outcome = await handle.done
        if (!await handle.waitForExit()) throw new NativeError('NATIVE_CLEANUP', 'Windows bridge process did not exit')
        if (outcome.exitCode !== 0 || outcome.signal !== null)
          throw new NativeError('NATIVE_CLEANUP', `Windows bridge exited unsuccessfully (${String(outcome.exitCode)}, ${String(outcome.signal)})`)
      } finally { clearTimeout(timer) }
    },
  }
}
