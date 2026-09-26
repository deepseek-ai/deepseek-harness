/** The bounded drain and the tree stop are measured against real child processes. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { runProfilePnpm, type PackageOperationOptions } from '../src/operations.ts'

/** Holds the inherited pipes until its stop file appears, and ends on its own after a minute. */
const HOLDER_SCRIPT = `
const { existsSync } = require('node:fs')
setInterval(() => { if (existsSync(process.env.DSH_DESCENDANT_STOP_FILE)) process.exit(0) }, 50)
setTimeout(() => process.exit(0), 60000)
`

/** Writes a marker after the run is over, which only a stopped tree can prevent. */
const LATE_SCRIPT = `
setTimeout(() => { require('node:fs').writeFileSync(process.env.DSH_LATE_FILE, 'late') }, 1500)
setTimeout(() => process.exit(0), 60000)
`

/**
 * A child that exits immediately while its descendant inherits both pipes and
 * outlives it, so execa's promise cannot settle before the bounded drain. It
 * runs from a file because Windows cannot carry a nested `-e` argument.
 */
const DRAIN_CHILD = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const descendant = spawn(process.execPath, [process.env.DSH_DESCENDANT_SCRIPT], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
writeFileSync(process.env.DSH_DESCENDANT_PID_FILE, String(descendant.pid))
console.log('installed')
setTimeout(() => process.exit(0), 50)
`

/** A child that starts a descendant and then never exits, so only the silence bound ends the run. */
const STALLED_CHILD = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const descendant = spawn(process.execPath, [process.env.DSH_DESCENDANT_SCRIPT], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
writeFileSync(process.env.DSH_DESCENDANT_PID_FILE, String(descendant.pid))
console.log('installing')
setTimeout(() => process.exit(0), 60000)
`

/** Read the descendant's published pid, waiting for the write a loaded runner can delay. */
async function readPid(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (pid > 0) return pid
    }
    await sleep(25)
  }
  throw new Error('the descendant published no process id')
}

/** Wait until a descendant this spec killed is really gone, so its directory can be removed. */
async function awaitGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { process.kill(pid, 0) } catch { return /* the descendant is gone */ }
    await sleep(25)
  }
}

/** A profile whose package run is `child`, with its descendant stopped during teardown. */
function fixture(child: string, descendant: string) {
  const home = mkdtempSync(join(tmpdir(), 'manager-run-'))
  const dir = join(home, 'profiles', 'test')
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{}\n')
  initProfile(dir, [])
  const pidFile = join(home, 'descendant.pid')
  const stopFile = join(home, 'descendant.stop')
  const scriptFile = join(home, 'descendant.cjs')
  const lateFile = join(home, 'late.marker')
  writeFileSync(scriptFile, descendant)
  onTestFinished(async () => {
    // The stop file ends a surviving descendant on its own; the kill only shortens the wait.
    writeFileSync(stopFile, '')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      try { process.kill(pid, 'SIGKILL') } catch { /* the descendant exited with its own timer */ }
      await awaitGone(pid)
    }
    rmSync(home, { recursive: true, force: true })
  })
  const options: PackageOperationOptions = {
    command: process.execPath, args: ['-e', child], execution: 'service', outputBytes: 1000,
    activateNewBundles: false,
    env: {
      DSH_DESCENDANT_PID_FILE: pidFile, DSH_DESCENDANT_STOP_FILE: stopFile,
      DSH_DESCENDANT_SCRIPT: scriptFile, DSH_LATE_FILE: lateFile,
    },
  }
  return { context: { home, profile: 'test', installAnchor, cwd: home }, pidFile, lateFile, options }
}

/**
 * Windows cannot stage these fixtures: there a descendant neither keeps the
 * inherited pipes open past the direct child's exit nor leads a group the run
 * can stop, so the drain's premise holds on POSIX alone. The drain itself is
 * platform-independent, and the mocked-child cases in operations.spec.ts cover
 * it everywhere.
 */
describe.skipIf(process.platform === 'win32')('a run with descendants', () => {
  it('settles a run whose pipes a descendant keeps open', async () => {
    const { context, pidFile, options } = fixture(DRAIN_CHILD, HOLDER_SCRIPT)
    const outcome = await runProfilePnpm(context, ['add', './held'], options)
    const descendant = await readPid(pidFile)
    expect(outcome).toMatchObject({ exitCode: 0 })
    expect(outcome.output).toContain('dsh: pnpm output was cut short after its process exited')
    // The descendant still holds the pipes, so the run settled under its drain bound instead of waiting for their end.
    expect(() => process.kill(descendant, 0)).not.toThrow()
  })

  it('surfaces an output consumer failure that the bounded drain cuts short', async () => {
    const { context, options } = fixture(DRAIN_CHILD, HOLDER_SCRIPT)
    const run = runProfilePnpm(context, ['add', './held'], {
      ...options,
      onOutput() { throw new Error('output destination closed') },
    })
    await expect(run).rejects.toThrow('output destination closed')
  })

  it('stops the whole tree of a stalled run before returning', async () => {
    const { context, pidFile, lateFile, options } = fixture(STALLED_CHILD, LATE_SCRIPT)
    const outcome = await runProfilePnpm(context, ['add', './stalled'], { ...options, idleTimeoutMs: 300 })
    const descendant = await readPid(pidFile)
    expect(outcome).toMatchObject({ timedOut: true })
    // The descendant is gone, so the marker it would have written 1.5s in never appears.
    expect(() => process.kill(descendant, 0)).toThrow()
    await sleep(2_000)
    expect(existsSync(lateFile)).toBe(false)
  })
})

it('waits for a run recorded by an exited operation before starting its own', async () => {
  const { context, lateFile, options } = fixture(
    // The run reports whether the recorded run had finished writing when it started.
    'console.log(require("node:fs").existsSync(process.env.DSH_LATE_FILE) ? "started after" : "started before")', '',
  )
  const orphan = spawn(process.execPath, ['-e', `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(lateFile)}, 'late') }, 500)`], {
    stdio: 'ignore',
  })
  onTestFinished(async () => {
    try { orphan.kill('SIGKILL') } catch { /* the recorded run already exited */ }
    await awaitGone(orphan.pid as number)
  })
  const dir = join(context.home, 'profiles', 'test')
  mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
  writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: orphan.pid, grouped: false }))
  const outcome = await runProfilePnpm(context, ['list'], options)
  expect(outcome).toMatchObject({ exitCode: 0, output: 'started after\n' })
  expect(existsSync(join(dir, '.plugin-manager', 'run.json'))).toBe(false)
})
