import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '../src/index.ts'
import { launchLinuxScope, probeLinuxScope } from '../src/linux-scope.ts'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-native-containment-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function spec(argv: string[], graceMs = 100): SubprocessSpawnSpec {
  return {
    argv,
    cwd: scratch,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs,
  }
}

type SpawnFailure = NodeJS.ErrnoException & { path?: string }

function directSpawnFailure(argv: readonly string[]): Promise<SpawnFailure> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd: scratch, stdio: 'ignore' })
    child.once('error', resolve)
    child.once('spawn', () => { reject(new Error(`expected ${argv[0]} to fail before spawn`)) })
  })
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {
      // The target has not written the file yet.
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
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
        if (state === 'Z' || state === 'X') return
      } catch {
        return
      }
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} remained alive`)
}

interface LinuxProcessState {
  parentPid: number
  processGroupId: number
  sessionId: number
  ttyNumber: number
  foregroundProcessGroupId: number
}

function readLinuxProcessState(pid: number): LinuxProcessState {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const [parentPid, processGroupId, sessionId, ttyNumber, foregroundProcessGroupId] = fields
    .slice(1, 6)
    .map(Number)
  if ([parentPid, processGroupId, sessionId, ttyNumber, foregroundProcessGroupId]
    .some(value => !Number.isSafeInteger(value))) {
    throw new Error(`invalid /proc state for pid ${String(pid)}`)
  }
  return {
    parentPid: parentPid as number,
    processGroupId: processGroupId as number,
    sessionId: sessionId as number,
    ttyNumber: ttyNumber as number,
    foregroundProcessGroupId: foregroundProcessGroupId as number,
  }
}

async function waitReparented(pid: number, originalParentPid: number): Promise<LinuxProcessState> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const state = readLinuxProcessState(pid)
    if (state.parentPid !== originalParentPid) return state
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${String(pid)} remained parented to ${String(originalParentPid)}`)
}

function captureTerminalOutput(handle: SubprocessTerminalHandle): {
  text(): string
  waitFor(marker: string): Promise<string>
} {
  let output = ''
  handle.output.on('data', (chunk: Buffer) => { output += chunk.toString() })
  return {
    text: () => output,
    waitFor: async (marker) => {
      const deadline = Date.now() + 5_000
      while (!output.includes(marker) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (!output.includes(marker)) {
        throw new Error(`terminal did not emit ${JSON.stringify(marker)}; output: ${JSON.stringify(output)}`)
      }
      return output
    },
  }
}

async function waitForInputReadiness(handle: SubprocessTerminalHandle): Promise<{
  processGroupId: number
  inputWaiting: boolean
}> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const foreground = await handle.inspectForeground()
    if (foreground?.inputWaiting === true) return foreground
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`terminal ${String(handle.pid)} never became input-ready`)
}

const linuxNative = process.platform === 'linux' && probeLinuxScope()

describe.skipIf(!linuxNative)('Linux user-systemd native containment', () => {
  it('terminates a setsid descendant and waits for the scope to become empty', async () => {
    const pidFile = join(scratch, `setsid-${Date.now()}.pid`)
    const command = `setsid sh -c 'echo $$ > "$1"; trap "" TERM; while :; do sleep 60; done' sh ${JSON.stringify(pidFile)} & wait`
    const request = spec(['bash', '-c', command], 80)
    const handle = bindManagedProcess(request, launchLinuxScope(request, targetEnvironment(request)))
    let descendant: number | undefined
    try {
      descendant = await waitForPid(pidFile)
      handle.terminate()
      await handle.done
      await expect(handle.waitForExit()).resolves.toBe(true)
      await waitGone(descendant)
    } finally {
      handle.terminate()
      await Promise.allSettled([handle.done, handle.waitForExit()])
      if (descendant !== undefined) {
        try { process.kill(descendant, 'SIGKILL') } catch { /* already contained */ }
      }
    }
  })

  it('preserves Node-shaped ENOENT and EACCES spawn failures without replay', async () => {
    const missingArgv = [`missing-native-target-${Date.now()}`, 'literal arg']
    const expectedMissing = await directSpawnFailure(missingArgv)
    const missing = spec(missingArgv)
    const missingHandle = bindManagedProcess(missing, launchLinuxScope(missing, targetEnvironment(missing)))
    await expect(missingHandle.done).rejects.toMatchObject({
      name: expectedMissing.name,
      message: expectedMissing.message,
      code: expectedMissing.code,
      syscall: expectedMissing.syscall,
      path: expectedMissing.path,
    })

    const deniedPath = join(scratch, `not-executable-${Date.now()}`)
    writeFileSync(deniedPath, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
    chmodSync(deniedPath, 0o600)
    const deniedArgv = [deniedPath, 'literal arg']
    const expectedDenied = await directSpawnFailure(deniedArgv)
    const denied = spec(deniedArgv)
    const deniedHandle = bindManagedProcess(denied, launchLinuxScope(denied, targetEnvironment(denied)))
    await expect(deniedHandle.done).rejects.toMatchObject({
      name: expectedDenied.name,
      message: expectedDenied.message,
      code: expectedDenied.code,
      syscall: expectedDenied.syscall,
      path: expectedDenied.path,
    })
  })

  it('keeps PTY identity and readiness while containing a reparented setsid descendant', async () => {
    const escapedPath = join(scratch, `escaped-terminal-${Date.now()}.sh`)
    const terminalPath = join(scratch, `terminal-${Date.now()}.sh`)
    const launcherPidFile = join(scratch, `terminal-launcher-${Date.now()}.pid`)
    const descendantPidFile = join(scratch, `terminal-descendant-${Date.now()}.pid`)
    writeFileSync(escapedPath, `#!/bin/sh
printf '%s\\n' "$$" > "$1"
trap '' TERM
while :; do sleep 60; done
`, { mode: 0o700 })
    writeFileSync(terminalPath, `#!/bin/bash
set -eu
launcher_pid_file=$1
descendant_pid_file=$2
escaped_path=$3
sh -c 'printf "%s\\n" "$$" > "$1"; setsid "$2" "$3" </dev/null >/dev/null 2>&1 &' sh "$launcher_pid_file" "$escaped_path" "$descendant_pid_file"
while [ ! -s "$descendant_pid_file" ]; do sleep 0.01; done
if [ -r /dev/tty ] && [ -w /dev/tty ]; then tty_ready=yes; else tty_ready=no; fi
printf 'PTY_READY pid=%s tty=%s\\n' "$$" "$tty_ready" > /dev/tty
IFS= read -r value < /dev/tty
printf 'PTY_INPUT=%s\\n' "$value" > /dev/tty
while :; do sleep 60; done
`, { mode: 0o700 })

    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    let descendant: number | undefined
    let handle: SubprocessTerminalHandle | undefined
    try {
      handle = await ctx.subprocess.spawnTerminal({
        argv: [terminalPath, launcherPidFile, descendantPidFile, escapedPath],
        cwd: scratch,
        rows: 24,
        cols: 80,
        graceMs: 100,
      })
      const output = captureTerminalOutput(handle)
      const readyOutput = await output.waitFor('PTY_READY')
      const reportedPid = Number(/PTY_READY pid=(\d+) tty=yes/.exec(readyOutput)?.[1])
      expect(reportedPid, readyOutput).toBe(handle.pid)

      const top = readLinuxProcessState(handle.pid)
      expect(top).toMatchObject({
        processGroupId: handle.pid,
        sessionId: handle.pid,
        foregroundProcessGroupId: handle.pid,
      })
      expect(top.ttyNumber).not.toBe(0)

      const foreground = await waitForInputReadiness(handle)
      expect(foreground).toEqual({ processGroupId: handle.pid, inputWaiting: true })
      await handle.write('continue\n')
      await output.waitFor('PTY_INPUT=continue')

      const launcher = await waitForPid(launcherPidFile)
      descendant = await waitForPid(descendantPidFile)
      const escaped = await waitReparented(descendant, launcher)
      expect(escaped.parentPid).not.toBe(launcher)
      expect(escaped.processGroupId).toBe(descendant)
      expect(escaped.sessionId).toBe(descendant)
      expect(escaped.sessionId).not.toBe(handle.pid)

      await handle.terminate()
      await handle.done
      await waitGone(descendant)
    } finally {
      if (handle !== undefined) await handle.terminate().catch(() => {})
      if (descendant !== undefined) {
        try { process.kill(descendant, 'SIGKILL') } catch { /* already contained */ }
      }
      await fiber.dispose()
    }
  }, 15_000)
})
