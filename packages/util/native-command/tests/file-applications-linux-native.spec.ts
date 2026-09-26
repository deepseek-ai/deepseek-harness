/** Real GIO discovery and desktop-entry launch in private XDG data/config roots. */
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { nativeFileApplications, openNativeFileApplication } from '../src/file-applications.ts'
import type { NativeCommandRunner } from '../src/runner.ts'

const gioAvailable = process.platform === 'linux' && spawnSync('gio', ['help'], { stdio: 'ignore' }).error === undefined
const execute = promisify(execFile)

/** Desktop Exec quoted-argument syntax; GIO performs its expansion. */
function quoted(value: string): string {
  return `"${value.replace(/[\\"`$]/g, match => `\\${match}`)}"`
}

it.skipIf(!gioAvailable)('queries and launches an installed Linux desktop entry through GIO', async ({ task }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gio-associations-'))
  const lifetime = new AbortController()
  const active = new Set<Promise<Awaited<ReturnType<NativeCommandRunner>>>>()
  onTestFinished(async () => {
    lifetime.abort()
    await Promise.allSettled([...active])
    await rm(root, { recursive: true, force: true })
  })
  const data = join(root, 'data')
  const config = join(root, 'config')
  const empty = join(root, 'empty')
  await mkdir(join(data, 'applications'), { recursive: true })
  await mkdir(config)
  await mkdir(empty)
  const path = join(root, "测试 ' file.txt")
  const script = join(root, 'handler.cjs')
  const marker = join(root, 'opened.json')
  await writeFile(path, 'plain text')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ path: process.argv[2], pid: process.pid }));\n`)
  const desktop = join(data, 'applications', 'dsh-test.desktop')
  await writeFile(desktop, `[Desktop Entry]\nType=Application\nName=DSH Test Handler\nExec=${quoted(process.execPath)} ${quoted(script)} %f\nMimeType=text/plain;\n`)
  await writeFile(join(data, 'applications', 'mimeinfo.cache'), '[MIME Cache]\ntext/plain=dsh-test.desktop;\n')
  await writeFile(join(config, 'mimeapps.list'), '[Default Applications]\ntext/plain=dsh-test.desktop;\n')
  const env = { ...process.env, XDG_DATA_HOME: data, XDG_DATA_DIRS: empty, XDG_CONFIG_HOME: config, XDG_CONFIG_DIRS: empty, LC_ALL: 'C' }
  const run: NativeCommandRunner = (command, args, signal) => {
    const task = execute(command, [...args], { signal, env, encoding: 'utf8' })
    active.add(task)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  }
  const apps = await nativeFileApplications(path, lifetime.signal, { run, env })
  expect(apps).toContainEqual({ id: desktop, name: 'DSH Test Handler', default: true, icon: null })
  await openNativeFileApplication(path, desktop, lifetime.signal, { run, env })
  let opened: { path: string; pid: number } | undefined
  await vi.waitFor(async () => {
    opened = JSON.parse(await readFile(marker, 'utf8')) as { path: string; pid: number }
    expect(opened.path).toBe(path)
  }, { timeout: task.timeout })
  await vi.waitFor(() => { expect(() => process.kill(opened!.pid, 0)).toThrow() }, { timeout: task.timeout })
})
