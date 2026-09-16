/** Built Desktop Host lifecycle with Electron disconnecting before profile startup settles. */

import { fork } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'
import { expect, it, onTestFinished } from 'vitest'

it.each([false, true])('settles startup after parent IPC disconnect (boot failure: %s)', async (fail) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-disconnect-'))
  const modules = join(root, 'node_modules', '@deepseek-ai')
  for (const name of ['dsh-app-boot', 'dsh', 'dsh-home-paths', 'dsh-tools']) mkdirSync(join(modules, name), { recursive: true })
  for (const [name, source] of [
    ['dsh-home-paths', `export const resolveDshHome = () => ${JSON.stringify(root)}`],
    ['dsh-tools', 'export const defineTool = value => value'],
  ] as const) {
    writeFileSync(join(modules, name, 'package.json'), '{"type":"module","exports":"./index.js"}')
    writeFileSync(join(modules, name, 'index.js'), source)
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(modules, 'dsh-app-boot', 'package.json'), '{"type":"module","exports":"./index.js"}')
  writeFileSync(join(modules, 'dsh-app-boot', 'index.js'), 'export const loadProfileDirectory = () => ({}); export const loadLayeredEnv = () => ({})')
  writeFileSync(join(modules, 'dsh', 'package.json'), '{"type":"module","exports":{"./profile-boot":"./profile-boot.js"}}')
  writeFileSync(join(modules, 'dsh', 'profile-boot.js'), `
    import { writeFileSync } from 'node:fs';
    export function runProfile() {
      process.send({ type: 'booting' });
      return new Promise((resolve, reject) => process.once('disconnect', () => {
        if (${String(fail)}) { reject(new Error('fixture boot failure')); return; }
        resolve({ ctx: { plugin: async () => {}, connection: { authenticatedUrl: value => value }, webServer: { port: 19387 } },
          shutdown: { shutdown: async () => writeFileSync(${JSON.stringify(join(root, 'stopped'))}, 'stopped') } });
      }));
    }
  `)
  const entry = join(root, 'index.js')
  copyFileSync(fileURLToPath(new URL('../../desktop-host/lib/index.js', import.meta.url)), entry)
  const child = fork(entry, [root, root], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  const drained = finished(child.stderr!, { cleanup: true })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([exited, drained])
    rmSync(root, { recursive: true, force: true })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => { resolve() })
      child.once('error', reject)
      child.once('exit', (code) => { reject(new Error(`Host exited before booting: ${String(code)} ${stderr}`)) })
    })
    child.disconnect()
    expect(await exited).toBe(fail ? 1 : 0)
    await drained
    expect(stderr).not.toContain('ERR_IPC_CHANNEL_CLOSED')
    expect(stderr).not.toContain('Unhandled')
    if (fail) expect(stderr).toContain('fixture boot failure')
    else expect(readFileSync(join(root, 'stopped'), 'utf8')).toBe('stopped')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([exited, drained])
  }
})
