/** Keyless import smoke for the attachment fixture; the built-bin lane supplies its published dependencies. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/built-attachment.mjs', import.meta.url))
const built = existsSync(new URL('../lib/index.js', import.meta.url))

it.skipIf(!built)('links the built attachment fixture and creates its identity without starting a browser', async ({ signal }) => {
  const run = promisify(execFile)(process.execPath, [fixture, '--check-imports'], { env: {}, signal })
  const closed = new Promise<void>((resolve) => { run.child.once('close', () => { resolve() }) })
  try {
    const { stdout } = await run
    expect(stdout.trim()).toBe('built-stagehand')
  } finally {
    await closed
  }
})
