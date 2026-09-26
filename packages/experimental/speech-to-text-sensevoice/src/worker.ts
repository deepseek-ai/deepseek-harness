/** Private child entry; the Host owns termination, and stdout carries only readiness. */
import { z } from 'zod'
import { Config } from './config.ts'
import { createTranscriber } from './inference.ts'
import { startRecognitionServer } from './process-server.ts'

const raw: unknown = JSON.parse(z.string().parse(process.argv[2]))
const paths = z.object({ model: z.string().min(1), tokens: z.string().min(1), vad: z.string().min(1) }).parse(raw)
const config = Object.assign(Config(z.record(z.string(), z.unknown()).parse(raw)), paths)
const token = z.string().regex(/^[a-f0-9]{64}$/).parse(process.env.DSH_SPEECH_TOKEN)
delete process.env.DSH_SPEECH_TOKEN
const { port } = await startRecognitionServer(token, config.maxAudioBytes, createTranscriber(config))
process.stdout.write(`${JSON.stringify({ port })}\n`)
