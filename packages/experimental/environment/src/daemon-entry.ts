/** Serve the execution protocol on one provider-owned standard input/output connection. */
/* v8 ignore file -- subprocess entry; source composition and built-artifact tests exercise it. */
import { writeSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { serveConnection } from './daemon.ts'
import { RpcDisconnectedError } from './protocol.ts'

/** Write one diagnostic synchronously so it survives the following process exit. */
function report(message: string): void {
  writeSync(2, `execution environment daemon: ${message}\n`)
}

function positive(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`requires a positive integer --${flag}`)
  return parsed
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: {
      'stdio': { type: 'boolean', default: false },
      'auth-timeout-ms': { type: 'string', default: '10000' },
    },
    strict: true,
  })
  if (mode !== 'serve' || !values.stdio) throw new Error('usage: daemon.js serve --stdio [--auth-timeout-ms <n>]')
  const authTimeoutMs = positive(values['auth-timeout-ms'], 'auth-timeout-ms')
  // Shipped code that drops a rejected promise must not end the runs sharing this process.
  process.on('unhandledRejection', (reason) => {
    report(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
  })
  const stop = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => { stop.abort(new Error(`Execution environment received ${signal}`)) })
  }
  const closed = await serveConnection({ input: process.stdin, output: process.stdout, mechanisms: ['transport'], authTimeoutMs, signal: stop.signal })
  // The provider closes stdin to stop the daemon; any other reason is a protocol failure.
  if (!(closed instanceof RpcDisconnectedError)) {
    report(closed.message)
    process.exitCode = 1
  }
}

main().then(
  // Runs whose code ignored the abort signal must not keep the process alive.
  () => { process.exit() },
  (error: unknown) => {
    report(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
