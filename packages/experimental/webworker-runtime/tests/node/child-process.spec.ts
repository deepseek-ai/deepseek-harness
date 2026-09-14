/**
 * The `node:child_process` face over the in-worker shell, and the ladder above
 * it: the REAL local subprocess service, running unmodified against this
 * module instead of a host kernel. The bash tool walks this same ladder in the
 * browser.
 *
 * A Node test host has no DOM `Worker`, so the commands here run through the
 * inline strategy; the worker strategy and its frames are proven in
 * `../shell/shell-process.spec.ts`.
 *
 * `process.kill` is redirected to the worker's process table for the same
 * reason the worker does it: the subprocess service polls process-group
 * liveness through it, and on a test host those pids belong to real processes.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { setActiveVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/active.ts'
import { spawn, spawnSync } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/child_process.ts'
import {
  LAUNCHER_FAILURE_EXIT, grantArgs, launcherPath, probe,
} from '@deepseek-ai/node-addon-system/landlock-run'
import { processAlive, signalProcess } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/process-table.ts'
import { hostFileSystem } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/fs-access.ts'
import {
  LANDLOCK_EXECUTABLE, landlockFileSystem, parseLandlockArguments,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/landlock.ts'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'

vi.mock('node:child_process', async () =>
  await import('@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/child_process.ts'))

const WORKSPACE = '/dsh/workspace'
const HOME = '/dsh/home'
const TMP = '/dsh/tmp'

let vfs: MemoryVfs

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync(WORKSPACE, { recursive: true })
  vfs.mkdirSync(HOME, { recursive: true })
  vfs.mkdirSync(TMP, { recursive: true })
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number): true => {
    if (signal === 0) {
      if (processAlive(pid)) return true
      const error = new Error('kill ESRCH') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }
    signalProcess(pid, (signal ?? 'SIGTERM') as NodeJS.Signals)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Collect one child's stdout, stderr, and settlement. */
async function collect(child: ReturnType<typeof spawn>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: unknown) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk) })
  const code = await new Promise<number | null>((settle, fail) => {
    child.on('close', (value: unknown) => { settle(value as number | null) })
    child.on('error', fail)
  })
  return { stdout, stderr, code }
}

it('runs a bash command line and reports its output through the pipes', async () => {
  const child = spawn('bash', ['-c', 'echo hi; echo oops >&2'], { cwd: WORKSPACE })
  expect(child.pid).toBeGreaterThan(1)
  expect(await collect(child)).toEqual({ stdout: 'hi\n', stderr: 'oops\n', code: 0 })
})

it('runs an explicit argv without re-parsing it as a command line', async () => {
  vfs.writeFileSync(`${WORKSPACE}/spaced name.txt`, 'kept\n')
  const child = spawn('cat', ['spaced name.txt'], { cwd: WORKSPACE })
  expect((await collect(child)).stdout).toBe('kept\n')
})

it('fails a program the command table does not hold the way a missing binary does', async () => {
  const child = spawn('nowhere-binary', [], { cwd: WORKSPACE })
  // A caller that configures the pipes first (the browser launcher does) must
  // reach the ENOENT, not a TypeError on the configuration line.
  child.stdout?.setEncoding()
  child.stderr?.setEncoding()
  const error = await new Promise<NodeJS.ErrnoException>((settle) => {
    child.on('error', (value: unknown) => { settle(value as NodeJS.ErrnoException) })
  })
  expect(error.code).toBe('ENOENT')
  expect(error.syscall).toBe('spawn nowhere-binary')
})

it('refuses a command name that is not a string, as Node does', () => {
  expect(() => spawn(undefined as unknown as string)).toThrow(/must be a non-empty string/)
})

it('reports that a synchronous run cannot happen, without throwing at the probe', () => {
  expect(spawnSync('bwrap').error?.code).toBe('ENOENT')
  expect(spawnSync('echo').error?.message).toContain('commands run asynchronously')
  expect(spawnSync(launcherPath(), ['--probe'])).toMatchObject({
    status: 0,
    stdout: Buffer.from('landlock: fully enforced\n'),
  })
  expect(spawnSync(launcherPath(), ['--ro', '/', '--', 'echo', 'x']).error?.message)
    .toContain('commands run asynchronously')
  const failedProbe = spawnSync(launcherPath(), ['--probe', '--'])
  expect(failedProbe.status).toBe(LAUNCHER_FAILURE_EXIT)
  expect(Buffer.isBuffer(failedProbe.stderr)).toBe(true)
})

it('keeps the native Landlock package API and CLI failure contract', async () => {
  expect(probe()).toBe('full')
  expect(probe('/not-the-worker-launcher')).toBe('unusable')
  expect(probe('/another-package-layout/bin/landlock-run')).toBe('full')
  expect(launcherPath(() => '/ignored/package.json')).toBe('/ignored/bin/landlock-run')
  expect(LAUNCHER_FAILURE_EXIT).toBe(125)
  expect(await collect(spawn(launcherPath(), ['--probe']))).toEqual({
    stdout: 'landlock: fully enforced\n', stderr: '', code: 0,
  })
  const malformed = spawn(launcherPath(), ['--rw'], { cwd: WORKSPACE })
  expect(await collect(malformed)).toEqual({
    stdout: '',
    stderr: 'landlock-run: usage error: --rw requires a path\n',
    code: 125,
  })
  const missingGrant = spawn(launcherPath(), ['--rw', '/dsh/missing', '--', 'touch', `${WORKSPACE}/never`], { cwd: WORKSPACE })
  expect(await collect(missingGrant)).toEqual({
    stdout: '',
    stderr: 'landlock-run: cannot open rule path: /dsh/missing: No such file or directory\n',
    code: 125,
  })
  expect(vfs.existsSync(`${WORKSPACE}/never`)).toBe(false)
  const missingCommand = spawn(launcherPath(), ['--ro', '/', '--', 'not-a-program'], { cwd: WORKSPACE })
  expect(await collect(missingCommand)).toEqual({
    stdout: '',
    stderr: 'landlock-run: exec failed: No such file or directory\n',
    code: 125,
  })
})

it('enforces every ShellFileSystem operation and virtual device edge', async () => {
  vfs.writeFileSync(`${HOME}/private.txt`, 'private\n')
  const invocation = parseLandlockArguments([
    ...grantArgs({ readOnly: ['/dev'], readWrite: [WORKSPACE, '/dev/null'] }), '--', 'true',
  ])
  if (invocation.kind !== 'run') throw new Error('expected a confined run invocation')
  const guarded = await landlockFileSystem(hostFileSystem(), invocation, WORKSPACE)

  expect(await guarded.stat('/dev/null')).toEqual({ directory: false, size: 0, mtimeMs: 0 })
  expect(await guarded.stat('/dev')).toEqual({ directory: true, size: 0, mtimeMs: 0 })
  expect(await guarded.list('/dev')).toEqual([{ name: 'null', directory: false }])
  await expect(guarded.list('/dev/null')).rejects.toMatchObject({ code: 'ENOTDIR' })
  expect(await guarded.readText('/dev/null')).toBe('')
  await guarded.writeText('/dev/null', 'discarded')
  await expect(guarded.mkdir('/dev/null', false)).rejects.toMatchObject({ code: 'EEXIST' })
  await expect(guarded.remove('/dev/null', { recursive: false, force: false })).rejects.toMatchObject({ code: 'EACCES' })
  await expect(guarded.rename('/dev/null', `${WORKSPACE}/null`)).rejects.toMatchObject({ code: 'EACCES' })
  await expect(guarded.stat('/dev/null/child')).rejects.toMatchObject({ code: 'ENOTDIR' })
  await expect(guarded.writeText('/dev/null/child', 'not written')).rejects.toMatchObject({ code: 'ENOTDIR' })
  await expect(guarded.mkdir('/dev/null/child', true)).rejects.toMatchObject({ code: 'ENOTDIR' })
  expect(vfs.existsSync('/dev')).toBe(false)
  await expect(guarded.readText(`${HOME}/private.txt`)).rejects.toMatchObject({ code: 'EACCES' })

  await guarded.mkdir('created', false)
  await guarded.writeText('created/file', 'one')
  await guarded.writeText('created/file', ' two', true)
  expect(await guarded.readText(`${WORKSPACE}/created/file`)).toBe('one two')
  expect(await guarded.list(`${WORKSPACE}/created`)).toEqual([{ name: 'file', directory: false }])
  await guarded.rename('created/file', 'created/moved')
  await expect(guarded.rename('created/moved', '/dev/null')).rejects.toMatchObject({ code: 'EACCES' })
  await guarded.remove('created', { recursive: true, force: false })
  expect(vfs.existsSync(`${WORKSPACE}/created`)).toBe(false)
})

it('turns an unexpected virtual-launcher preparation failure into exit 125', async () => {
  const base = hostFileSystem()
  const result = await LANDLOCK_EXECUTABLE.prepare(
    ['--ro', '/', '--', 'true'],
    {
      cwd: WORKSPACE,
      filesystem: { ...base, stat: () => Promise.reject(new Error('storage unavailable')) },
    },
  )
  expect(result).toEqual({
    kind: 'exit', exitCode: 125, stdout: '', stderr: 'landlock-run: Error: storage unavailable\n',
  })
})

it.each([
  { args: [], message: 'missing `-- <argv>...` command' },
  { args: ['--unknown', '--', 'true'], message: 'unknown argument: --unknown' },
  { args: ['--probe', '--'], message: '--probe takes no other arguments' },
  { args: ['--'], message: 'missing `-- <argv>...` command' },
  { args: ['--rw', '', '--', 'true'], message: 'cannot open rule path' },
])('rejects malformed Landlock argv before execution: $message', async ({ args, message }) => {
  const child = spawn(launcherPath(), args, { cwd: WORKSPACE })
  const result = await collect(child)
  expect(result.code).toBe(LAUNCHER_FAILURE_EXIT)
  expect(result.stderr).toContain(message)
})

it('enforces read-only and workspace-write grants over the VFS', async () => {
  vfs.writeFileSync(`${HOME}/readable.txt`, 'visible\n')
  const readOnly = spawn(launcherPath(), [
    ...grantArgs({ readOnly: ['/'], readWrite: ['/dev/null'] }),
    '--', 'bash', '-c', `cat ${HOME}/readable.txt; echo discarded > /dev/null; echo denied > ${WORKSPACE}/denied.txt`,
  ], { cwd: WORKSPACE })
  const strict = await collect(readOnly)
  expect(strict.code).toBe(1)
  expect(strict.stdout).toBe('visible\n')
  expect(strict.stderr.toLowerCase()).toContain('permission denied')
  expect(vfs.existsSync(`${WORKSPACE}/denied.txt`)).toBe(false)

  const workspaceWrite = spawn(launcherPath(), [
    ...grantArgs({ readOnly: ['/'], readWrite: ['/dev/null', '/tmp', WORKSPACE] }),
    '--', 'bash', '-c', `echo workspace > ${WORKSPACE}/allowed.txt; echo temporary > /tmp/temp.txt; cat /tmp/temp.txt`,
  ], { cwd: WORKSPACE })
  expect(await collect(workspaceWrite)).toEqual({ stdout: 'temporary\n', stderr: '', code: 0 })
  expect(vfs.readFileSync(`${WORKSPACE}/allowed.txt`, 'utf8')).toBe('workspace\n')
  expect(vfs.readFileSync(`${TMP}/temp.txt`, 'utf8')).toBe('temporary\n')
  expect(vfs.existsSync('/dev/null')).toBe(false)
})

it('normalizes relative grants and denies sibling-prefix escapes and unreadable paths', async () => {
  vfs.mkdirSync(`${WORKSPACE}/nested`)
  vfs.mkdirSync(`${WORKSPACE}-other`)
  vfs.writeFileSync(`${HOME}/private.txt`, 'private\n')
  const child = spawn(launcherPath(), [
    ...grantArgs({ readOnly: [WORKSPACE], readWrite: ['.'] }),
    '--', 'bash', '-c', `echo kept > nested/relative.txt; echo escaped > ${WORKSPACE}-other/escape.txt; cat ${HOME}/private.txt`,
  ], { cwd: WORKSPACE })
  const result = await collect(child)
  expect(result.code).toBe(1)
  expect(result.stderr.toLowerCase()).toContain('permission denied')
  expect(vfs.readFileSync(`${WORKSPACE}/nested/relative.txt`, 'utf8')).toBe('kept\n')
  expect(vfs.existsSync(`${WORKSPACE}-other/escape.txt`)).toBe(false)
  expect(result.stdout).not.toContain('private')
})

it('treats trailing-slash grants as the same subtree', async () => {
  const invocation = parseLandlockArguments(['--rw', '/tmp/', '--', 'true'])
  if (invocation.kind !== 'run') throw new Error('expected a confined run invocation')
  const guarded = await landlockFileSystem(hostFileSystem(), invocation, WORKSPACE)
  await guarded.writeText('/tmp/nested.txt', 'allowed')
  expect(vfs.readFileSync(`${TMP}/nested.txt`, 'utf8')).toBe('allowed')
})

it('presents the virtual device directory without storing it in the VFS', async () => {
  const child = spawn(launcherPath(), [
    ...grantArgs({ readOnly: ['/'], readWrite: ['/dev/null'] }),
    '--', 'bash', '-c', 'ls /dev; cat /dev/null',
  ], { cwd: WORKSPACE })
  expect(await collect(child)).toEqual({ stdout: 'null\n', stderr: '', code: 0 })
  expect(vfs.existsSync('/dev')).toBe(false)
})

it('requires both rename paths to be writable', async () => {
  vfs.writeFileSync(`${WORKSPACE}/source.txt`, 'kept\n')
  const child = spawn(launcherPath(), [
    ...grantArgs({ readOnly: ['/'], readWrite: [WORKSPACE] }),
    '--', 'mv', `${WORKSPACE}/source.txt`, `${HOME}/moved.txt`,
  ], { cwd: WORKSPACE })
  const result = await collect(child)
  expect(result.code).toBe(1)
  expect(result.stderr.toLowerCase()).toContain('permission denied')
  expect(vfs.readFileSync(`${WORKSPACE}/source.txt`, 'utf8')).toBe('kept\n')
  expect(vfs.existsSync(`${HOME}/moved.txt`)).toBe(false)
})

it('keeps concurrent Landlock grants process-local', async () => {
  const strict = spawn(launcherPath(), [
    ...grantArgs({ readOnly: ['/'], readWrite: ['/dev/null'] }),
    '--', 'bash', '-c', `sleep 0.02; echo denied > ${WORKSPACE}/strict.txt`,
  ], { cwd: WORKSPACE })
  const writable = spawn(launcherPath(), [
    ...grantArgs({ readOnly: ['/'], readWrite: ['/dev/null', WORKSPACE] }),
    '--', 'bash', '-c', `echo allowed > ${WORKSPACE}/writable.txt`,
  ], { cwd: WORKSPACE })
  const [strictResult, writableResult] = await Promise.all([collect(strict), collect(writable)])
  expect(strictResult.code).toBe(1)
  expect(strictResult.stderr.toLowerCase()).toContain('permission denied')
  expect(writableResult).toEqual({ stdout: '', stderr: '', code: 0 })
  expect(vfs.existsSync(`${WORKSPACE}/strict.txt`)).toBe(false)
  expect(vfs.readFileSync(`${WORKSPACE}/writable.txt`, 'utf8')).toBe('allowed\n')
})

it('carries a command through the real local subprocess service', async () => {
  const handle = spawnSubprocess({
    argv: ['bash', '-c', 'echo written > note.txt && cat note.txt'],
    cwd: WORKSPACE,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 3_000,
    env: {},
  })
  const outcome = await handle.done
  expect(outcome).toEqual({ exitCode: 0, signal: null })
  expect(handle.collected.stdout?.readFrom(0).text).toBe('written\n')
  expect(vfs.readFileSync(`${WORKSPACE}/note.txt`, 'utf8')).toBe('written\n')
})

it('writes the caller-supplied standard input into the command', async () => {
  const handle = spawnSubprocess({
    argv: ['bash', '-c', 'grep -c ""'],
    cwd: WORKSPACE,
    stdio: {
      stdin: { data: 'one\ntwo\nthree\n' },
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 3_000,
    env: {},
  })
  await handle.done
  expect(handle.collected.stdout?.readFrom(0).text).toBe('3\n')
})

it('kills a running command through the service and reports the signal', async () => {
  const handle = spawnSubprocess({
    argv: ['bash', '-c', 'sleep 30; echo never'],
    cwd: WORKSPACE,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 3_000,
    env: {},
  })
  const started = performance.now()
  handle.terminate()
  const outcome = await handle.done
  expect(outcome.signal).toBe('SIGTERM')
  expect(outcome.exitCode).toBeNull()
  expect(handle.collected.stdout?.readFrom(0).text).toBe('')
  // The command settles on the signal, not on the interval it was waiting out:
  // a `sleep` that ignored the abort would hold this handle open for 30s.
  expect(performance.now() - started).toBeLessThan(5_000)
})
