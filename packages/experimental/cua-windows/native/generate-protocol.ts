/** Generate Windows native admission from the shared CUA operation definitions. */
import { readFile, writeFile } from 'node:fs/promises'
import { nativeProtocol } from '@deepseek-ai/dsh-cua/native-schema'

const path = new URL('protocol.schema.json', import.meta.url)
const content = nativeProtocol().json
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== content) throw new Error('Stale Windows CUA native request schema')
} else await writeFile(path, content)
