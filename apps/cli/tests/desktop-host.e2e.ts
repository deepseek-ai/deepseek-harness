/** Built Desktop Host credential receipt and shutdown before profile startup settles. */

import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'
import { expect, it, onTestFinished } from 'vitest'

it.each([
  { event: 'disconnect', phase: 'credentials', fail: false },
  { event: 'shutdown', phase: 'credentials', fail: false },
  { event: 'invalid-credential', phase: 'credentials', fail: true },
  { event: 'disconnect', phase: 'startup', fail: false },
  { event: 'disconnect', phase: 'startup', fail: true },
  { event: 'shutdown', phase: 'startup', fail: false },
  { event: 'shutdown', phase: 'startup', fail: true },
] as const)('settles $event while waiting for $phase (failure: $fail)', async ({ event, phase, fail }) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-disconnect-'))
  const modules = join(root, 'node_modules', '@deepseek-ai')
  const hostDirectory = fileURLToPath(new URL('../../desktop-host/', import.meta.url))
  const manifest = JSON.parse(readFileSync(join(hostDirectory, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const stubbed = new Set(['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh'])
  for (const name of Object.keys(manifest.dependencies)) {
    const destination = join(root, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    if (stubbed.has(name)) mkdirSync(destination)
    else symlinkSync(realpathSync(join(hostDirectory, 'node_modules', name)), destination, 'junction')
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(modules, 'dsh-app-boot', 'package.json'), '{"type":"module","exports":"./index.js"}')
  writeFileSync(join(modules, 'dsh-app-boot', 'index.js'), `
    import { writeFileSync } from 'node:fs';
    export class StartupError extends Error {}
    export const loadProfileDirectory = () => {
      writeFileSync(${JSON.stringify(join(root, 'profile-loaded'))}, 'loaded');
      return { skippedBundles: [] };
    };
    export const reportSkippedBundles = () => {};
    export const loadLayeredEnv = () => ({});
  `)
  writeFileSync(join(modules, 'dsh', 'package.json'), '{"type":"module","exports":{"./profile-boot":"./profile-boot.js"}}')
  writeFileSync(join(modules, 'dsh', 'profile-boot.js'), `
    import { writeFileSync } from 'node:fs';
    export function runProfile(options) {
      process.send({ type: 'booting', packageManager: options.packageManager });
      return new Promise((resolve, reject) => {
        const settle = () => {
          process.off('disconnect', settle);
          process.off('message', onMessage);
          if (${String(fail)}) { reject(new Error('fixture boot failure')); return; }
          resolve({ ctx: { plugin: async () => {}, effect: () => {}, on: () => {}, inject: () => {},
            connection: { authenticatedUrl: value => value }, webServer: { port: 19387 } },
            shutdown: { shutdown: async () => writeFileSync(${JSON.stringify(join(root, 'stopped'))}, 'stopped') } });
        };
        const onMessage = message => { if (message.type === 'shutdown') settle(); };
        process.once('disconnect', settle);
        process.on('message', onMessage);
      });
    }
  `)
  const entry = join(root, 'index.js')
  copyFileSync(join(hostDirectory, 'lib', 'index.js'), entry)
  const pnpm = join(root, 'bundled-pnpm.mjs')
  const nodeBin = join(root, 'bin')
  const child = fork(entry, [root, root, root, pnpm, nodeBin], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  const drained = finished(child.stderr!, { cleanup: true })
  const messages: unknown[] = []
  child.on('message', (message) => { messages.push(message) })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([exited, drained])
    rmSync(root, { recursive: true, force: true })
  })
  try {
    const boot = await new Promise<{
      packageManager: { command: string; args: string[]; env: Record<string, string> }
    } | undefined>((resolve, reject) => {
      child.on('message', (message) => {
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'starting') {
          if (phase === 'credentials') { resolve(undefined); return }
          child.send({ type: 'desktop-auth', secret: randomBytes(32).toString('base64url') }, (error) => {
            if (error !== null) reject(error)
          })
        }
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'booting' && 'packageManager' in message) {
          resolve(message as { packageManager: { command: string; args: string[]; env: Record<string, string> } })
        }
      })
      child.once('error', reject)
      child.once('exit', (code) => { reject(new Error(`Host exited before ${phase}: ${String(code)} ${stderr}`)) })
    })
    if (phase === 'startup') {
      expect(boot?.packageManager.command).toBe(process.execPath)
      expect(boot?.packageManager.args).toEqual(['--expose-internals', pnpm])
      expect(boot?.packageManager.env.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(boot?.packageManager.env.PATH).toBe(`${nodeBin}${delimiter}${process.env.PATH ?? ''}`)
    }
    if (event === 'disconnect') child.disconnect()
    else await new Promise<void>((resolve, reject) => {
      child.send(event === 'shutdown' ? { type: 'shutdown' } : { type: 'desktop-auth', secret: 'bad-secret' }, (error) => {
        if (error === null) resolve()
        else reject(error)
      })
    })
    const exitCode = await exited
    await drained
    expect(child.signalCode).toBeNull()
    expect(exitCode, stderr).toBe(fail ? 1 : 0)
    expect(stderr).not.toContain('ERR_IPC_CHANNEL_CLOSED')
    expect(stderr).not.toContain('Unhandled')
    expect(messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ready' })]))
    if (event === 'shutdown' && !fail) {
      expect(messages.filter(message => typeof message === 'object' && message !== null && 'type' in message
        && message.type === 'shutdown-complete')).toHaveLength(1)
    }
    if (fail) {
      expect(stderr).toContain(event === 'invalid-credential' ? 'Desktop authentication message is invalid' : 'fixture boot failure')
    } else {
      expect(stderr).toBe('')
      expect(messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'fatal' })]))
    }
    if (phase === 'credentials') {
      expect(existsSync(join(root, 'profile-loaded'))).toBe(false)
      expect(existsSync(join(root, 'stopped'))).toBe(false)
      expect(messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'booting' })]))
    } else if (!fail) expect(readFileSync(join(root, 'stopped'), 'utf8')).toBe('stopped')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([exited, drained])
  }
})
