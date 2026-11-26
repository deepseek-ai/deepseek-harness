import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapDaemon, loadDaemon, SshEnvironmentError, type DaemonBundle } from '../src/bootstrap.ts'
import { remoteCommand, shellQuote, type SshCommandResult } from '../src/openssh.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn(original.readFile) }
})

const metadata = { version: '1.2.3-test', protocol: 2, node: '^24.22.3 || >=26.13.1' }
const source = `// dsh-environment-daemon ${JSON.stringify(metadata)}\nthrow new Error('daemon source must never execute during bootstrap')\n`
const bundle: DaemonBundle = { source, ...metadata, digest: createHash('sha256').update(source).digest('hex') }
const active = () => new AbortController().signal

async function execute(command: string, input?: string): Promise<SshCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      if (signal !== null) reject(new Error(`Bootstrap test command terminated by ${signal}`))
      else resolve({ exitCode, stdout, stderr })
    })
    // A concurrent installer may finish without reading this invocation's upload.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error) })
    child.stdin.end(input)
  })
}

describe('SSH daemon bootstrap', () => {
  let root: string
  let config: { host: string; node: string; daemonPath: string }
  let calls: { command: string; input: string | undefined }[]
  let run: typeof execute

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'dsh-bootstrap-'))
    // The host test runner may use an older engine; only remote version fixtures change.
    const preload = join(root, 'supported.cjs')
    await fs.writeFile(preload, "Object.defineProperty(process.versions, 'node', { value: '24.22.3' })\n")
    const node = join(root, "node executable's path")
    await fs.writeFile(node, `#!/bin/sh\nexec ${shellQuote(process.execPath)} --require ${shellQuote(preload)} "$@"\n`, { mode: 0o700 })
    config = { host: 'test-box', node, daemonPath: join(root, "daemon folder's path", 'daemon.js') }
    calls = []
    run = async (command, input) => { calls.push({ command, input }); return await execute(command, input) }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('uploads an absent daemon privately, then reuses identical bytes without an upload', async () => {
    await bootstrapDaemon(run, config, bundle, active())
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(source)
    expect((await fs.stat(config.daemonPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(join(root, "daemon folder's path"))).mode & 0o777).toBe(0o700)
    expect(calls.map(call => call.input)).toEqual([undefined, source])
    expect(await fs.readdir(join(root, "daemon folder's path"))).toEqual(['daemon.js'])
    await bootstrapDaemon(run, config, bundle, active())
    expect(calls).toHaveLength(3)
    expect(calls[2]?.input).toBeUndefined()
  })

  it('resolves an omitted daemonPath from the remote home directory', async () => {
    await fs.appendFile(join(root, 'supported.cjs'), `require('node:os').homedir = () => ${JSON.stringify(root)};\n`)
    const destination = await bootstrapDaemon(run, { host: config.host, node: config.node }, bundle, active())
    expect(destination).toBe(join(root, '.cache', 'dsh', 'environment', 'daemon.js'))
    expect(await fs.readFile(destination, 'utf8')).toBe(source)
  })

  it('upgrades a lower daemon version and preserves newer or invalid versions', async () => {
    await fs.mkdir(join(root, "daemon folder's path"))
    for (const version of ['1.0.0', '1.2.3-alpha.1']) {
      await fs.writeFile(config.daemonPath, source.replace('1.2.3-test', version))
      await expect(bootstrapDaemon(run, config, bundle, active())).resolves.toBe(config.daemonPath)
      expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(source)
      expect(await fs.readdir(join(root, "daemon folder's path"))).toEqual(['daemon.js'])
    }
    for (const version of ['2.0.0', 'invalid']) {
      const existing = source.replace('1.2.3-test', version)
      await fs.writeFile(config.daemonPath, existing)
      await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE' })
      expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(existing)
    }
  })

  it('does not downgrade a newer release published after the upgrade probe', async () => {
    await fs.mkdir(join(root, "daemon folder's path"))
    await fs.writeFile(config.daemonPath, source.replace('1.2.3-test', '1.0.0'))
    const newer = source.replace('1.2.3-test', '2.0.0')
    const competingRun = async (command: string, input?: string) => {
      if (input !== undefined) await fs.writeFile(config.daemonPath, newer)
      return await run(command, input)
    }
    await expect(bootstrapDaemon(competingRun, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE' })
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(newer)
  })

  it('refuses to execute bytes replaced after bootstrap', async () => {
    const executableSource = `// dsh-environment-daemon ${JSON.stringify(metadata)}\nprocess.stdout.write('original')\n`
    const executableBundle = { ...bundle, source: executableSource, digest: createHash('sha256').update(executableSource).digest('hex') }
    await bootstrapDaemon(run, config, executableBundle, active())
    const command = remoteCommand({ ...config, digest: executableBundle.digest })
    expect((await execute(command)).stdout).toBe('original')
    await fs.writeFile(config.daemonPath, executableSource.replace("'original'", "'replacement'"))
    const refused = await execute(command)
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('Execution daemon changed after bootstrap')
  })

  it('preserves another installer lock and permits retry after its release', async () => {
    await fs.mkdir(join(root, "daemon folder's path"))
    const older = source.replace('1.2.3-test', '1.0.0')
    await fs.writeFile(config.daemonPath, older)
    await fs.mkdir(`${config.daemonPath}.install-lock`)
    await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED', message: expect.stringContaining('installation is busy') as string })
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(older)
    expect((await fs.stat(`${config.daemonPath}.install-lock`)).isDirectory()).toBe(true)
    await fs.rmdir(`${config.daemonPath}.install-lock`)
    await bootstrapDaemon(run, config, bundle, active())
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(source)
  })

  it.each([
    ['unrecognized source', 'process.exit(99)\n'],
    ['different version', source.replace('1.2.3-test', '2.0.0')],
    ['different protocol', source.replace('"protocol":2', '"protocol":3')],
    ['same version with a different digest', `${source}// other build\n`],
    ['invalid JSON', '// dsh-environment-daemon {\n'],
    ['extra metadata fields', source.replace('"protocol":2', '"extra":true,"protocol":2')],
    ['missing metadata line ending', `// dsh-environment-daemon ${JSON.stringify(metadata)}`],
  ])('preserves a preexisting daemon with %s', async (_name, existing) => {
    await fs.mkdir(join(root, "daemon folder's path"))
    await fs.writeFile(config.daemonPath, existing)
    await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ name: 'SshEnvironmentError', code: 'ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE' })
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(existing)
    expect(calls).toHaveLength(1)
  })

  it('rejects directories and symlinks without replacing them', async () => {
    await fs.mkdir(config.daemonPath, { recursive: true })
    await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE' })
    await fs.rmdir(config.daemonPath)
    const target = join(root, 'target.js')
    await fs.writeFile(target, source)
    await fs.symlink(target, config.daemonPath)
    await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE' })
    expect(await fs.readlink(config.daemonPath)).toBe(target)
  })

  it('classifies a missing configured Node executable before attempting upload', async () => {
    config.node = join(root, 'absent-node')
    await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_NODE_NOT_FOUND', message: expect.stringContaining('test-box') as string })
    expect(calls).toHaveLength(1)
  })

  it.each(['24.22.2', '25.0.0', '26.13.0'])('rejects unsupported Node %s', async (version) => {
    await fs.writeFile(join(root, 'supported.cjs'), `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} })\n`)
    await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_NODE_UNSUPPORTED', message: expect.stringContaining(version) as string })
    expect(calls).toHaveLength(1)
  })

  it.each(['24.23.0', '26.13.1', '26.14.0', '27.0.0'])('accepts supported Node %s', async (version) => {
    await fs.writeFile(join(root, 'supported.cjs'), `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} })\n`)
    await bootstrapDaemon(run, config, bundle, active())
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(source)
  })

  it('uses the daemon engine range when selecting supported Node versions', async () => {
    const custom = { ...bundle, node: '>=28.1.0 <29' }
    await expect(bootstrapDaemon(run, config, custom, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_NODE_UNSUPPORTED' })
    expect(calls).toHaveLength(1)
    await expect(fs.stat(config.daemonPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.writeFile(join(root, 'supported.cjs'), "Object.defineProperty(process.versions, 'node', { value: '28.1.0' })\n")
    await bootstrapDaemon(run, config, custom, active())
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(source)
  })

  it('reports a required builtin that the configured runtime cannot load', async () => {
    await fs.appendFile(join(root, 'supported.cjs'), `
const Module = require('node:module');
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'node:child_process') throw new Error('builtin disabled');
  return original.call(this, name, ...args);
};
`)
    await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_DEPENDENCY_MISSING', message: expect.stringContaining('node:child_process') as string })
  })

  it('publishes only one daemon when two uploads reach the absent target together', async () => {
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const concurrentRun = async (command: string, input?: string) => {
      if (input !== undefined) {
        arrivals++
        if (arrivals === 2) release()
        await barrier
      }
      return await run(command, input)
    }
    const results = await Promise.allSettled([
      bootstrapDaemon(concurrentRun, config, bundle, active()), bootstrapDaemon(concurrentRun, config, bundle, active()),
    ])
    expect(results.some(result => result.status === 'fulfilled')).toBe(true)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED', message: expect.stringContaining('installation is busy') as string })
    expect(await bootstrapDaemon(run, config, bundle, active())).toBe(config.daemonPath)
    expect(arrivals).toBe(2)
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(source)
    expect(await fs.readdir(join(root, "daemon folder's path"))).toEqual(['daemon.js'])
  })

  it('rejects an incompatible winner between the probe and upload without changing it', async () => {
    const existing = `${source}// competing build\n`
    const competingRun = async (command: string, input?: string) => {
      if (input !== undefined) {
        await fs.mkdir(join(root, "daemon folder's path"))
        await fs.writeFile(config.daemonPath, existing)
      }
      return await run(command, input)
    }
    await expect(bootstrapDaemon(competingRun, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_DAEMON_INCOMPATIBLE' })
    expect(await fs.readFile(config.daemonPath, 'utf8')).toBe(existing)
  })

  it('rejects corrupted upload bytes and leaves the target absent', async () => {
    await expect(bootstrapDaemon((command, input) => run(command, input === undefined ? undefined : `${input}corrupt`), config, bundle, active()))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED', message: expect.stringContaining('SHA-256 mismatch') as string })
    await expect(fs.stat(config.daemonPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves cancellation before dispatch, between phases, and from a rejected runner', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel bootstrap')
    controller.abort(reason)
    await expect(bootstrapDaemon(run, config, bundle, controller.signal)).rejects.toBe(reason)
    expect(calls).toHaveLength(0)
    const midway = new AbortController()
    await expect(bootstrapDaemon(async (command, input) => {
      const result = await run(command, input)
      midway.abort(reason)
      return result
    }, config, bundle, midway.signal)).rejects.toBe(reason)
    expect(calls).toHaveLength(1)
    const rejected = new AbortController()
    await expect(bootstrapDaemon(async () => {
      rejected.abort(reason)
      throw reason
    }, config, bundle, rejected.signal)).rejects.toBe(reason)
  })

  it('preserves cancellation during a real upload without publishing partial bytes', async () => {
    const ready = join(root, 'upload-opened')
    await fs.appendFile(join(root, 'supported.cjs'), `
const fs = require('node:fs');
const original = fs.openSync;
fs.openSync = function(file, ...args) {
  const fd = original.call(this, file, ...args);
  if (String(file).includes('.upload-')) {
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return fd;
};
`)
    const controller = new AbortController()
    const reason = new Error('cancel active upload')
    let terminate: (() => void) | undefined
    let closed: Promise<void> | undefined
    let stopped = false
    const uploading = async (command: string, input?: string): Promise<SshCommandResult> => {
      if (input === undefined) return await execute(command)
      return await new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
        terminate = () => { child.kill('SIGKILL') }
        closed = new Promise<void>((finish) => { child.once('close', () => { stopped = true; finish() }) })
        const abort = (): void => { child.kill('SIGTERM') }
        controller.signal.addEventListener('abort', abort, { once: true })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
        child.once('error', reject)
        child.once('close', (exitCode) => {
          controller.signal.removeEventListener('abort', abort)
          resolve({ exitCode, stdout, stderr })
        })
        child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error) })
        child.stdin.end(input)
      })
    }
    const pending = bootstrapDaemon(uploading, config, bundle, controller.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    try {
      await vi.waitFor(async () => { expect(await fs.readFile(ready, 'utf8')).toBe('ready') }, { timeout: 10_000 })
      controller.abort(reason)
      await rejected
      expect(stopped).toBe(true)
      await expect(fs.stat(config.daemonPath)).rejects.toMatchObject({ code: 'ENOENT' })
      // Forced termination may leave its private temporary file, which the test root owns.
      expect(await fs.readdir(join(root, "daemon folder's path"))).toEqual([expect.stringMatching(/^daemon\.js\.upload-/)])
    } finally {
      terminate?.()
      await closed
      await pending.catch((error: unknown) => {
        // The assertion above owns the bootstrap rejection; cleanup only waits for settlement.
        return error
      })
    }
  })

  it('converts runner failures and malformed process responses into bootstrap errors', async () => {
    const cause = new Error('ssh unavailable')
    await expect(bootstrapDaemon(async () => { throw cause }, config, bundle, active())).rejects.toMatchObject({ name: 'SshEnvironmentError', code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED', cause })
    for (const result of [
      { exitCode: 255, stdout: '', stderr: 'permission denied' },
      { exitCode: 0, stdout: 'not JSON', stderr: '' },
      { exitCode: 0, stdout: '{"status":"ready","nodeVersion":"24.22.3","daemonPath":"/test/daemon.js","unexpected":true}', stderr: '' },
      { exitCode: 0, stdout: '{"status":"error","nodeVersion":"24.22.3","daemonPath":"/test/daemon.js","code":"FOREIGN","message":"bad"}', stderr: '' },
    ]) await expect(bootstrapDaemon(async () => result, config, bundle, active())).rejects.toBeInstanceOf(SshEnvironmentError)
    await expect(bootstrapDaemon(async () => ({ exitCode: 0, stdout: '{"status":"missing","nodeVersion":"24.22.3","daemonPath":"/test/daemon.js"}', stderr: '' }), config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED' })
  })

  it('reports filesystem installation failures without changing an existing parent file', async () => {
    await fs.writeFile(join(root, "daemon folder's path"), 'parent is a file')
    await expect(bootstrapDaemon(run, config, bundle, active())).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED' })
    expect(await fs.readFile(join(root, "daemon folder's path"), 'utf8')).toBe('parent is a file')
  })

  it('loads the installed artifact banner and hashes its complete source', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(source)
    await expect(loadDaemon()).resolves.toEqual(bundle)
  })

  it.each(['unrecognized\n', '// dsh-environment-daemon {\n', `// dsh-environment-daemon ${JSON.stringify(metadata)}`, `// dsh-environment-daemon ${' '.repeat(4097)}\n`])('rejects a missing or invalid local daemon banner', async (invalid) => {
    vi.spyOn(fs, 'readFile').mockResolvedValueOnce(invalid)
    await expect(loadDaemon()).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED' })
  })

  it('preserves the cause when the installed daemon cannot be read', async () => {
    const cause = new Error('artifact missing')
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(cause)
    await expect(loadDaemon()).rejects.toMatchObject({ code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED', cause })
  })
})
