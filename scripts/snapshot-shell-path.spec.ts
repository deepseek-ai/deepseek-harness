import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as adapter from './snapshot-shell-path.ts'

it.skipIf(process.platform === 'win32')('translates only the exact fixture command and preserves real shell failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-shell-'))
  const ctx = new Context()
  const disposers: (() => Promise<void>)[] = []
  try {
    const subprocess = ctx.plugin(LocalSubprocessRuntime)
    disposers.push(() => subprocess.dispose())
    await subprocess
    const bash = ctx.plugin(LocalBashExecutor)
    disposers.push(() => bash.dispose())
    await bash
    const command = "printf 'actual bytes' > /fixture/recorded.txt"
    const livePath = join(root, "space and 'quote.txt")
    const fork = ctx.plugin(adapter, { command, recordedPath: '/fixture/recorded.txt', livePath })
    disposers.push(() => fork.dispose())
    await fork
    const outcome = await ctx.shell.run(ctx.shell.resolve({ command }))
    expect(outcome.timedOut).toBe(false)
    expect(outcome.exitCode).toBe(0)
    expect(await readFile(livePath, 'utf8')).toBe('actual bytes')
    const untouched = await ctx.shell.run(ctx.shell.resolve({ command: "printf '/fixture/recorded.txt'; exit 7" }))
    expect(untouched.exitCode).toBe(7)
    expect(untouched.stdout.text).toBe('/fixture/recorded.txt')
    await fork.dispose()
    await rm(livePath)
    const restored = await ctx.shell.run(ctx.shell.resolve({ command }))
    expect(restored.exitCode).not.toBe(0)
    await expect(readFile(livePath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  }
})
