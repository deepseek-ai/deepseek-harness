/** Private OpenSSH process entry; the helper module owns request and cleanup behavior. */
/* v8 ignore file -- launched through plain Node in SSH acceptance; helper behavior is exercised through its explicit streams. */
import { fileURLToPath } from 'node:url'
import { runSshHelper } from './helper.ts'

const controller = new AbortController()
const stop = (): void => { controller.abort(new Error('SSH helper process terminated')) }
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.once(signal, stop)
try {
  if (process.argv.length !== 2) throw new Error('SSH helper accepts no command arguments')
  await runSshHelper({ input: process.stdin, output: process.stdout, entryPath: fileURLToPath(import.meta.url), signal: controller.signal })
} catch (error) {
  process.stderr.write(`dsh-ssh-sandbox: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 127
} finally {
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.off(signal, stop)
}
