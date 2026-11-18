/** Tarball payload test with isolated declared dependencies and no external OAR package. */

import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { pnpmInvocation } from '../../../../scripts/pnpm-invocation.ts'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const built = existsSync(join(packageDirectory, 'lib/index.js'))
const nativeFixture = fileURLToPath(new URL('./fixtures/claude-protocol.mjs', import.meta.url))

// The shell shim is POSIX-specific; the provider and generic lifecycle suites remain cross-platform.
it.skipIf(!built || process.platform === 'win32')(
  'runs the packed provider with its embedded Claude permission patch and no resolvable external OAR',
  { timeout: 120_000, retry: 0 },
  async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-oar-packed-'))
    test.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const run = async (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => {
      const result = await execa(command, args, {
        cwd, env, stdin: 'ignore', timeout: 90_000, cancelSignal: test.signal,
        killSignal: 'SIGKILL', reject: false,
      })
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.isCanceled, result.stderr).toBe(false)
      expect(result.signal, result.stderr).toBeUndefined()
      expect(result.exitCode, result.stderr).toBe(0)
      return result.stdout
    }
    const invocation = pnpmInvocation(['pack', '--pack-destination', root])
    await run(invocation.command, invocation.args, packageDirectory)
    const archive = (await readdir(root)).find(name => name.endsWith('.tgz'))
    expect(archive).toBeDefined()
    await run('tar', ['-xzf', join(root, archive!), '-C', root], root)
    const consumer = join(root, 'package')
    const manifest = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
    expect(manifest.dependencies?.['@botiverse/oar']).toBeUndefined()
    for (const name of names) {
      const destination = join(consumer, 'node_modules', name)
      await mkdir(dirname(destination), { recursive: true })
      await symlink(join(packageDirectory, 'node_modules', name), destination, 'dir')
    }
    const binary = join(root, 'claude')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nativeFixture)} "$@"\n`)
    await chmod(binary, 0o700)
    const argvPath = join(root, 'argv.json')
    const script = `
      import assert from 'node:assert/strict'
      import { Context } from '@deepseek-ai/cordis'
      import * as provider from './lib/index.js'
      assert.throws(() => import.meta.resolve('@botiverse/oar'), { code: 'ERR_MODULE_NOT_FOUND' })
      const ctx = new Context()
      let registered
      ctx.provide('subagents', { registerProvider(value) { registered = value; return () => {} } })
      try {
        await ctx.plugin(provider, { runtime: 'claude', providerName: 'packed', timeoutMs: 10000,
          launchArgs: ['--permission-mode', 'dontAsk', '--permission-prompts', 'none'],
          env: { OAR_ARGV_FILE: ${JSON.stringify(argvPath)} } })
        assert.ok(registered)
        const run = await registered.start({ cwd: process.cwd(), signal: new AbortController().signal,
          parent: { id: 'packed-parent', session: { header: { cwd: process.cwd() } } },
          prompt: [{ type: 'text', text: 'Return the fixture answer.' }] })
        const result = await run.result
        await run.dispose()
        assert.equal(result.stopReason, 'completed', JSON.stringify(result))
        assert.deepEqual(result.output, [{ type: 'text', text: 'PACKED_OAR_OK' }])
        console.log('PACKED_PATCH_OK')
      } finally { await ctx.fiber.dispose() }
    `
    expect(await run(process.execPath, ['--input-type=module', '-e', script], consumer, {
      OAR_CLAUDE_BIN: binary, NODE_OPTIONS: '', NODE_PATH: '',
    })).toContain('PACKED_PATCH_OK')
    const args = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
    expect(args).toContain('--permission-mode')
    expect(args).toContain('dontAsk')
    expect(args).not.toContain('--dangerously-skip-permissions')
  },
)
