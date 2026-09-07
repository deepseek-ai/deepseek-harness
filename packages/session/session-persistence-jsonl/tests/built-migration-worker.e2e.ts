import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/worker.cjs']
  .every(path => existsSync(join(packageRoot, path)))

describe.skipIf(!built)('built migration verifier (plain node)', () => {
  it('publishes a historical generation through the bundled worker', async () => {
    const script = `
      import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      import { Context } from '@deepseek-ai/cordis'
      import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

      const root = await mkdtemp(join(tmpdir(), 'dsh-built-migration-'))
      const id = 'built-migration-worker'
      const directory = join(root, '_no-cwd', id)
      const ctx = new Context()
      try {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'session.jsonl'), JSON.stringify({
          type: 'session', version: 0, id, createdAt: 1, delegationDepth: 0,
        }) + '\\n')
        await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
        const handle = await ctx.sessionPersistence.open(id, 'write')
        await handle.close()
        await ctx.sessionPersistence.flush()
        const header = JSON.parse((await readFile(join(directory, 'session.v2.jsonl'), 'utf8')).trim())
        console.log(JSON.stringify({ id: header.id, version: header.version }))
      } finally {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    `
    const { exitCode, stdout, stderr } = await execa(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: packageRoot, stdin: 'ignore', timeout: 30_000, killSignal: 'SIGKILL', reject: false },
    )

    expect(exitCode, `stderr:\n${stderr}`).toBe(0)
    expect(JSON.parse(stdout.trim())).toEqual({ id: 'built-migration-worker', version: 2 })
  })
})
