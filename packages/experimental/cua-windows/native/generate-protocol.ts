/** Generate Windows native admission from the shared CUA operation definitions. */
import { readFile, writeFile } from 'node:fs/promises'
import { nativeProtocol } from '@deepseek-ai/dsh-cua/native-schema'
import { z } from 'zod'

const path = new URL('protocol.schema.json', import.meta.url)
const owner = z.object({ taskId: z.string().min(1) }).strict()
const content = nativeProtocol({
  sendKeyEvent: owner,
  toggleMouse: owner,
}, ['getHeldInputs', 'releaseHeldInputs'].map(method => z.object({
  method: z.literal(method), params: owner,
}).strict())).json
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== content) throw new Error('Stale Windows CUA native request schema')
} else await writeFile(path, content)
