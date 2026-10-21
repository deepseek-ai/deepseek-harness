/**
 * Private child process entry: load the native recognizer, listen on loopback, then print
 * `{"port":N}` and a newline as the only stdout output. The Host passes the configuration and
 * model paths as JSON in `argv[2]` and the bearer secret in `DSH_SPEECH_TOKEN`, which is removed
 * from the environment once read. A failure before readiness writes only its message to stderr,
 * which the Host includes in the preparation error, and exits with code 1. After readiness the
 * loopback listener keeps the process alive until the Host terminates it.
 */
import { z } from 'zod'
import { Config } from './config.ts'
import { createTranscriber } from './inference.ts'
import { startRecognitionServer } from './process-server.ts'

async function main(): Promise<void> {
  const raw: unknown = JSON.parse(z.string().parse(process.argv[2]))
  const paths = z.object({ model: z.string().min(1), tokens: z.string().min(1), vad: z.string().min(1) }).parse(raw)
  const config = Object.assign(Config(z.record(z.string(), z.unknown()).parse(raw)), paths)
  const token = z.string().regex(/^[a-f0-9]{64}$/).parse(process.env.DSH_SPEECH_TOKEN)
  delete process.env.DSH_SPEECH_TOKEN
  const { port } = await startRecognitionServer(token, config.maxAudioBytes, createTranscriber(config))
  process.stdout.write(`${JSON.stringify({ port })}\n`)
}

main().catch((error: unknown) => {
  // Exit once the message is flushed: a loaded native recognizer would otherwise keep the process alive.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => { process.exit(1) })
})
