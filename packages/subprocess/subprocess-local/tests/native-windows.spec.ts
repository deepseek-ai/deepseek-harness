import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'
import { launchWindowsJob, probeWindowsJob } from '../src/windows-job.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-native-windows-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function spec(argv: string[], graceMs = 100, env?: NodeJS.ProcessEnv): SubprocessSpawnSpec {
  return {
    argv,
    cwd: scratch,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs,
    env,
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {
      // Target has not written its descendant pid yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid file ${path} was not written`)
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} remained alive`)
}

function cleanup(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

type SpawnFailure = NodeJS.ErrnoException & { path?: string }

function expectedSpawnFailure(error: SpawnFailure): Record<string, unknown> {
  const expected: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    code: error.code,
    syscall: error.syscall,
  }
  if (Object.hasOwn(error, 'path')) expected.path = error.path
  return expected
}

function directSpawnFailure(argv: readonly string[], cwd = scratch): Promise<SpawnFailure> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(argv[0] as string, argv.slice(1), { cwd, stdio: 'ignore' })
      child.once('error', resolve)
      child.once('spawn', () => { reject(new Error(`expected ${argv[0]} to fail before spawn`)) })
    } catch (error) {
      resolve(error as SpawnFailure)
    }
  })
}

const windowsNative = process.platform === 'win32' && probeWindowsJob()

describe.skipIf(!windowsNative)('Windows Job native containment', () => {
  it('keeps raw stdin writable while the runner starts the target', async () => {
    const output = join(scratch, `stdin-${Date.now()}.txt`)
    const script = `
      const { writeFileSync } = require('node:fs')
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => { input += chunk })
      process.stdin.on('end', () => { writeFileSync(${JSON.stringify(output)}, input) })
    `
    const request = {
      ...spec([process.execPath, '-e', script]),
      stdio: { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' } as const,
    }
    const handle = bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request)))
    if (handle.stdin === undefined) throw new Error('expected piped stdin')
    await new Promise<void>((resolve, reject) => {
      handle.stdin?.once('error', reject)
      handle.stdin?.end('immediate-stdin', resolve)
    })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(readFileSync(output, 'utf8')).toBe('immediate-stdin')
  })

  it('preserves direct Node null-device semantics for ignored stdin', async () => {
    const script = `
      const stat = require('node:fs').fstatSync(0)
      process.stdout.write(JSON.stringify({
        file: stat.isFile(),
        directory: stat.isDirectory(),
        block: stat.isBlockDevice(),
        character: stat.isCharacterDevice(),
        fifo: stat.isFIFO(),
        socket: stat.isSocket(),
      }))
    `
    const direct = spawnSync(process.execPath, ['-e', script], {
      cwd: scratch,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    })
    expect(direct.status).toBe(0)

    const request = spec([process.execPath, '-e', script])
    const handle = bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request)))
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(handle.collected.stdout?.readFrom(0).text).toBe(direct.stdout)
  })

  it('reports direct exit before terminating its default-inheritance descendant', async () => {
    const pidFile = join(scratch, `job-survivor-${Date.now()}.pid`)
    const factsFile = join(scratch, `job-facts-${Date.now()}.json`)
    const targetCwd = join(scratch, `target-cwd-${Date.now()}`)
    mkdirSync(targetCwd)
    const script = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const { dirname } = require('node:path')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dirname(process.execPath), stdio: 'ignore', detached: true })
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
      writeFileSync(${JSON.stringify(factsFile)}, JSON.stringify({ cwd: process.cwd(), value: process.env.TARGET_VALUE, arg: process.argv[1] }))
      child.unref()
      process.stdout.end()
      process.stderr.end()
      process.exitCode = 42
    `
    const request = {
      ...spec([process.execPath, '-e', script, 'literal $HOME ${UNCHANGED}'], 100, { TARGET_VALUE: 'explicit' }),
      cwd: targetCwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } as const,
    }
    const handle = bindManagedProcess(request, launchWindowsJob(request, targetEnvironment(request)))
    let descendant: number | undefined
    try {
      if (handle.stdout === undefined) throw new Error('expected piped stdout')
      if (handle.stderr === undefined) throw new Error('expected piped stderr')
      handle.stdout.resume()
      handle.stderr.resume()
      const stdoutEnded = new Promise<void>((resolve, reject) => {
        handle.stdout?.once('end', resolve)
        handle.stdout?.once('error', reject)
      })
      const stderrEnded = new Promise<void>((resolve, reject) => {
        handle.stderr?.once('end', resolve)
        handle.stderr?.once('error', reject)
      })
      descendant = await waitForPid(pidFile)
      await expect(handle.done).resolves.toEqual({ exitCode: 42, signal: null })
      await expect(Promise.race([
        Promise.all([stdoutEnded, stderrEnded]).then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => { resolve(false) }, 5_000)),
      ])).resolves.toBe(true)
      expect(readFileSync(factsFile, 'utf8')).toBe(JSON.stringify({
        cwd: targetCwd,
        value: 'explicit',
        arg: 'literal $HOME ${UNCHANGED}',
      }))
      await expect(handle.waitForExit(AbortSignal.timeout(30))).resolves.toBe(false)
      handle.terminate()
      await expect(handle.waitForExit()).resolves.toBe(true)
      await waitGone(descendant)
    } finally {
      handle.terminate()
      await Promise.allSettled([handle.done, handle.waitForExit()])
      if (descendant !== undefined) cleanup(descendant)
      rmSync(targetCwd, { recursive: true, force: true })
    }
  })

  it('preserves missing-target and invalid-executable rejection errors', async () => {
    const relativeExecutable = `relative-node-${String(Date.now())}.exe`
    copyFileSync(process.execPath, join(scratch, relativeExecutable))
    const relative = spec([relativeExecutable, '-e', 'process.exit(17)'])
    const relativeHandle = bindManagedProcess(relative, launchWindowsJob(relative, targetEnvironment(relative)))
    await expect(relativeHandle.done).resolves.toEqual({ exitCode: 17, signal: null })
    await expect(relativeHandle.waitForExit()).resolves.toBe(true)

    const missing = spec([`missing-native-target-${Date.now()}.exe`])
    const expectedMissing = await directSpawnFailure(missing.argv)
    const missingHandle = bindManagedProcess(missing, launchWindowsJob(missing, targetEnvironment(missing)))
    await expect(missingHandle.done).rejects.toMatchObject(expectedSpawnFailure(expectedMissing))
    await expect(missingHandle.waitForExit()).resolves.toBe(true)

    const expectedAccessDenied = await directSpawnFailure([scratch])
    const accessDenied = spec([scratch])
    const accessDeniedHandle = bindManagedProcess(accessDenied, launchWindowsJob(accessDenied, targetEnvironment(accessDenied)))
    await expect(accessDeniedHandle.done).rejects.toMatchObject(expectedSpawnFailure(expectedAccessDenied))
    await expect(accessDeniedHandle.waitForExit()).resolves.toBe(true)

    const missingCwd = join(scratch, `missing-cwd-${Date.now()}`)
    const cwdArgv = [process.execPath, '-e', 'process.exit(0)']
    const expectedCwd = await directSpawnFailure(cwdArgv, missingCwd)
    const invalidCwd = { ...spec(cwdArgv), cwd: missingCwd }
    const invalidCwdHandle = bindManagedProcess(invalidCwd, launchWindowsJob(invalidCwd, targetEnvironment(invalidCwd)))
    await expect(invalidCwdHandle.done).rejects.toMatchObject(expectedSpawnFailure(expectedCwd))
    await expect(invalidCwdHandle.waitForExit()).resolves.toBe(true)

    const invalidExecutable = join(scratch, `direct-${Date.now()}.exe`)
    writeFileSync(invalidExecutable, 'not a Windows executable\r\n')
    const directError = await directSpawnFailure([invalidExecutable])
    const invalid = spec([invalidExecutable])
    const invalidHandle = bindManagedProcess(invalid, launchWindowsJob(invalid, targetEnvironment(invalid)))
    await expect(invalidHandle.done).rejects.toMatchObject(expectedSpawnFailure(directError))
    await expect(invalidHandle.waitForExit()).resolves.toBe(true)
  })
})
