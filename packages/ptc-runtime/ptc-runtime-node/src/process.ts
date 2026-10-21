/** Node child execution through typed host and program RPC methods. */
import type { Duplex } from 'node:stream'
import { createProcessRpc } from './rpc.ts'
import { runProgram } from './bootstrap.ts'
import { clearProgramEnvironment } from './environment.ts'
import type { PatchableStream } from './bootstrap.ts'
import type { HostMethods, ProgramMethods } from './protocol.ts'

/** Process-owned environment and output streams consumed by the child bootstrap. */
export interface ProgramProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  exitCode: string | number | null | undefined
}

/**
 * Serve one run and retain the endpoint until the host receives its result and closes it.
 * @param stream - Inherited, already-adopted control endpoint.
 * @param maxMessageBytes - Host-validated maximum message and queued-write bytes.
 * @param processState - Environment, output streams and exit status of this Node child.
 * @returns After host shutdown or a transport failure closes the endpoint.
 */
export async function runNodeMain(stream: Duplex, maxMessageBytes: number, processState: ProgramProcess): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) throw new Error('invalid control message limit')
  clearProgramEnvironment(processState)
  const hostClosed = Promise.withResolvers<void>()
  // Set once the result is returned or the endpoint closes; binding calls then never settle and output is dropped.
  let ended = false
  const unsettled = new Promise<never>(() => {})
  const connection = createProcessRpc<HostMethods, ProgramMethods>(stream, maxMessageBytes, {
    async run(_cwd, data) {
      const result = await runProgram({
        invoke: (global, name, args) => ended ? unsettled : connection.invoke(global, name, args).catch((error: unknown) => {
          // Closure rejects outstanding calls; an unawaited one would crash the child into the result logs.
          if (ended) return unsettled
          throw error
        }),
        log: (text) => { if (!ended) void connection.log(text) },
        outputLimit: () => { if (!ended) void connection.outputLimit() },
      }, data, processState)
      ended = true
      return result
    },
  }, ['ready', 'log', 'outputLimit'], (_error, kind) => {
    if (!ended || kind === 'protocol') processState.exitCode = 1
    ended = true
    hostClosed.resolve()
  })
  await connection.ready()
  await hostClosed.promise
}
