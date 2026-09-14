/** Same-user signals must not expose an unconfined helper's Node debugger. */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { describe, expect, it } from 'vitest'

// This fixture has no credentials, application state, or descendants. Port zero
// keeps the deliberately vulnerable control away from existing inspectors.
const fixture = `
process.stdin.on('data', () => setTimeout(() => process.stdout.write(JSON.stringify({ active: require('node:inspector').url() !== undefined }) + '\\n'), 100));
process.stdin.on('end', () => process.exit(0));
process.stdout.write('ready\\n');
`

describe.skipIf(process.platform !== 'darwin')('SSH helper inspector signal hardening', () => {
  it.each([false, true])('observes actual debugger activation with SIGUSR1 disabled=%s', async (disabled) => {
    const root = await realpath(await mkdtemp('/tmp/dsh-ssh-inspector-'))
    const ctx = new Context()
    const sandbox = await ctx.plugin(LocalSandboxProvider)
    const child = spawn(process.execPath, [...(disabled ? ['--disable-sigusr1'] : []), '--inspect-port=0', '-e', fixture], {
      cwd: root, env: {}, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const closed = once(child, 'close')
    const watchdog = setTimeout(() => { child.kill('SIGKILL') }, 5000)
    const lines = createInterface({ input: child.stdout })
    const replies = lines[Symbol.asyncIterator]()
    const debuggerStarted = Promise.withResolvers<undefined>()
    let diagnostics = ''
    child.stderr.on('data', (bytes: Buffer) => {
      diagnostics += bytes.toString()
      if (diagnostics.includes('Debugger listening on ws://127.0.0.1:')) debuggerStarted.resolve(undefined)
    })
    try {
      expect((await replies.next()).value).toBe('ready')
      const signal = await ctx.sandbox.confine([process.execPath, '-e', `process.kill(${String(child.pid)}, 'SIGUSR1')`], {
        mode: 'read-only', workspaceRoot: root,
      })
      const sender = spawnSync(signal.argv[0]!, signal.argv.slice(1), { cwd: root, env: {}, encoding: 'utf8', timeout: 3000 })
      expect(sender.error).toBeUndefined()
      expect(sender.status, sender.stderr).toBe(0)
      if (!disabled) await Promise.race([
        debuggerStarted.promise,
        closed.then(() => { throw new Error('Control exited without starting its Inspector') }),
      ])
      child.stdin.write('inspect\n')
      expect(JSON.parse((await replies.next()).value as string)).toEqual({ active: !disabled })
      if (disabled) expect(diagnostics).not.toContain('Debugger listening')
    } finally {
      clearTimeout(watchdog)
      lines.close()
      child.kill('SIGTERM')
      await closed
      await sandbox.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
