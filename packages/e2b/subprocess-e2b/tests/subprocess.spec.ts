import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import {
  CommandExitError,
  FileNotFoundError,
  SandboxNotFoundError,
  type CommandHandle,
  type CommandResult,
  type Sandbox,
} from '@deepseek-ai/dsh-e2b'
import type E2BRuntime from '@deepseek-ai/dsh-e2b'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import E2BSubprocessRuntime from '@deepseek-ai/dsh-subprocess-e2b'
import { E2BBase64Decoder, E2B_OUTPUT_COMPLETE_FRAME, E2BOutputReader } from '../src/output.ts'
import { E2BSubprocessHandle } from '../src/process.ts'
import { describe, expect, it, vi } from 'vitest'

function commandError(exitCode: number): CommandExitError {
  return new CommandExitError({ exitCode, stdout: '', stderr: '', error: `exit ${exitCode}` })
}

interface StartOptions {
  background: true
  cwd: string
  stdin: boolean
  timeoutMs: number
  signal?: AbortSignal
  envs?: Record<string, string>
  onStdout?: (data: string) => void | Promise<void>
  onStderr?: (data: string) => void | Promise<void>
}

class FakeCommandHandle {
  pid = 4242
  readonly sent: Array<string | Uint8Array> = []
  closes = 0
  kills = 0
  disconnects = 0
  killError: unknown
  killResult = true
  disconnectError: unknown
  private readonly result = Promise.withResolvers<CommandResult>()
  private settled = false

  constructor(private readonly onKill: () => void = () => {}) {}

  wait(): Promise<CommandResult> {
    return this.result.promise
  }

  async sendStdin(data: string | Uint8Array): Promise<void> {
    this.sent.push(data)
  }

  async closeStdin(): Promise<void> {
    this.closes += 1
  }

  async kill(): Promise<boolean> {
    this.kills += 1
    if (this.killError !== undefined) throw this.killError
    this.onKill()
    return this.killResult
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1
    if (this.disconnectError !== undefined) throw this.disconnectError
  }

  succeed(exitCode = 0): void {
    if (this.settled) return
    this.settled = true
    this.result.resolve({ exitCode, stdout: '', stderr: '' })
  }

  fail(exitCode: number): void {
    if (this.settled) return
    this.settled = true
    this.result.reject(commandError(exitCode))
  }

  crash(error: unknown): void {
    if (this.settled) return
    this.settled = true
    this.result.reject(error)
  }
}

class FakeSandbox {
  readonly handle: FakeCommandHandle
  readonly commandsSeen: string[] = []
  readonly writtenFiles: string[][] = []
  readonly writtenFileData = new Map<string, string>()
  readonly removed: string[] = []
  readonly directories: string[] = []
  startOptions: StartOptions | undefined
  backgroundError: unknown
  envError: unknown
  statusError: unknown
  nextRemoveError: unknown
  probeError: unknown
  signalError: unknown
  readonly signalErrors: unknown[] = []
  trapsTerm = false
  delaysKill = false
  delaysKillCompletion = false
  sdkKillStops = true
  alive = true
  zombieOnly = false
  ambient = 'PATH=/ambient/bin\0KEEP=safe\0UNICODE=你好\0NPM_TOKEN=secret\0DSH_STALE=old\0BROKEN\0=bad\0'
  environmentHome = '/home/user'
  environmentWire: string | undefined
  environmentRequest: ((signal: AbortSignal | undefined) => Promise<void>) | undefined
  processGroupId = '4242\n'
  exitStatus = ''
  statusReads = 0
  readonly processGroupReads: string[] = []
  afterStatusRead: (() => void) | undefined
  beforeProbe: (() => void) | undefined
  afterProbe: (() => void) | undefined
  private startGate: Promise<void> | undefined
  private openStart: (() => void) | undefined
  private processGroupReadGate: Promise<void> | undefined
  private openProcessGroupRead: (() => void) | undefined
  private signalGate: Promise<void> | undefined
  private openSignal: (() => void) | undefined

  constructor() {
    this.handle = new FakeCommandHandle(() => {
      if (this.sdkKillStops) {
        this.alive = false
        this.handle.fail(137)
      }
    })
  }

  deferStart(): void {
    const gate = Promise.withResolvers<undefined>()
    this.startGate = gate.promise
    this.openStart = () => { gate.resolve(undefined) }
  }

  releaseStart(): void {
    this.openStart?.()
  }

  deferProcessGroupRead(): void {
    const gate = Promise.withResolvers<undefined>()
    this.processGroupReadGate = gate.promise
    this.openProcessGroupRead = () => { gate.resolve(undefined) }
  }

  releaseProcessGroupRead(): void {
    this.openProcessGroupRead?.()
  }

  deferSignals(): void {
    const gate = Promise.withResolvers<undefined>()
    this.signalGate = gate.promise
    this.openSignal = () => { gate.resolve(undefined) }
  }

  releaseSignals(): void {
    this.openSignal?.()
  }

  finish(exitCode = 0): void {
    this.alive = false
    void this.completeOutput().then(
      () => {
        if (exitCode === 0) this.handle.succeed(0)
        else this.handle.fail(exitCode)
      },
      (error: unknown) => { this.handle.crash(error) },
    )
  }

  async completeOutput(): Promise<void> {
    await Promise.all([
      this.stdoutWire(`${E2B_OUTPUT_COMPLETE_FRAME}\n`),
      this.stderrWire(`${E2B_OUTPUT_COMPLETE_FRAME}\n`),
    ])
  }

  async stdout(data: string): Promise<void> {
    await this.stdoutWire(data.length === 0 ? '' : `${Buffer.from(data).toString('base64')}\n`)
  }

  async stderr(data: string): Promise<void> {
    await this.stderrWire(data.length === 0 ? '' : `${Buffer.from(data).toString('base64')}\n`)
  }

  async stdoutWire(data: string): Promise<void> {
    await this.startOptions?.onStdout?.(data)
  }

  async stderrWire(data: string): Promise<void> {
    await this.startOptions?.onStderr?.(data)
  }

  readonly sandbox = {
    sandboxId: 'fake',
    files: {
      makeDir: async (path: string): Promise<boolean> => {
        this.directories.push(path)
        return true
      },
      write: async (files: Array<{ path: string; data: string }>): Promise<object[]> => {
        this.writtenFiles.push(files.map(file => file.path))
        for (const file of files) this.writtenFileData.set(file.path, file.data)
        return files.map(() => ({}))
      },
      read: async (path: string): Promise<string> => {
        if (!path.endsWith('/exit-code')) {
          await this.processGroupReadGate
          return this.processGroupReads.shift() ?? this.processGroupId
        }
        if (this.statusError !== undefined) {
          const error = this.statusError
          this.statusError = undefined
          throw error
        }
        this.statusReads += 1
        this.afterStatusRead?.()
        return this.exitStatus
      },
      remove: async (path: string): Promise<void> => {
        this.removed.push(path)
        if (this.nextRemoveError !== undefined) {
          const error = this.nextRemoveError
          this.nextRemoveError = undefined
          throw error
        }
      },
    },
    commands: {
      run: async (command: string, options?: StartOptions | { signal?: AbortSignal }): Promise<CommandHandle | CommandResult> => {
        this.commandsSeen.push(command)
        if (command.includes('env -0 | base64')) {
          await this.environmentRequest?.(options?.signal)
          if (this.envError !== undefined) throw this.envError
          return {
            exitCode: 0,
            stdout: this.environmentWire ?? [this.environmentHome, this.ambient]
              .map(value => Buffer.from(value).toString('base64'))
              .join('\n'),
            stderr: '',
          }
        }
        if (command.startsWith('set -o pipefail; ps -eo pgid=,stat=')) {
          this.beforeProbe?.()
          if (options?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
          if (this.probeError !== undefined) {
            const error = this.probeError
            this.probeError = undefined
            throw error
          }
          const stdout = this.alive && !this.zombieOnly ? 'live\n' : ''
          this.afterProbe?.()
          return { exitCode: 0, stdout, stderr: '' }
        }
        if (command.startsWith('kill -TERM ')) {
          await this.signalGate
          const error = this.signalErrors.shift() ?? this.signalError
          if (error !== undefined) {
            if (this.signalErrors.length === 0) this.signalError = undefined
            throw error
          }
          if (!this.trapsTerm) {
            this.alive = false
            this.handle.fail(143)
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (command.startsWith('kill -KILL ')) {
          await this.signalGate
          const error = this.signalErrors.shift() ?? this.signalError
          if (error !== undefined) {
            if (this.signalErrors.length === 0) this.signalError = undefined
            throw error
          }
          if (!this.delaysKill) this.alive = false
          if (!this.delaysKillCompletion) this.handle.fail(137)
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        if ((options as StartOptions | undefined)?.background === true) {
          this.startOptions = options as StartOptions
          await this.startGate
          if (this.backgroundError !== undefined) throw this.backgroundError
          return this.handle as unknown as CommandHandle
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as Sandbox
}

function spec(overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', 'printf ok'],
    cwd: '/workspace',
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4, spill: { maxBytes: 16 } },
      stderr: { maxBytes: 4 },
    },
    graceMs: 5,
    ...overrides,
  }
}

function runtime(fake: FakeSandbox, getSandbox: () => Promise<Sandbox> = async () => fake.sandbox): E2BRuntime {
  return {
    cwd: '/workspace',
    runtimeRoot: '/workspace/.dsh-e2b',
    getSandbox,
  } as unknown as E2BRuntime
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Construct the handle under test with the config default the service would pass. */
function testHandle(
  runtime: ConstructorParameters<typeof E2BSubprocessHandle>[0],
  spec: ConstructorParameters<typeof E2BSubprocessHandle>[1],
  stateDir: string,
  pollMs = 20,
): E2BSubprocessHandle {
  return new E2BSubprocessHandle(runtime, spec, stateDir, pollMs)
}

describe('E2BOutputReader', () => {
  it('decodes base64 across arbitrary callback boundaries and rejects malformed framing', () => {
    const decoder = new E2BBase64Decoder()
    expect(decoder.push('')).toEqual(Buffer.alloc(0))
    expect(decoder.push('5')).toEqual(Buffer.alloc(0))
    expect(decoder.push('L2')).toEqual(Buffer.alloc(0))
    expect(decoder.push('g\n').toString()).toBe('你')
    expect(decoder.push('YQ==\nYg==\n').toString()).toBe('ab')
    expect(decoder.push(`${Buffer.from([0, 255]).toString('base64')}\n`)).toEqual(Buffer.from([0, 255]))
    expect(decoder.push(`${E2B_OUTPUT_COMPLETE_FRAME}\n`)).toEqual(Buffer.alloc(0))
    decoder.finish()

    expect(() => new E2BBase64Decoder().push('%\n')).toThrow('invalid base64')
    expect(() => new E2BBase64Decoder().push('AB==\n')).toThrow('invalid base64')
    expect(() => decoder.push(`${E2B_OUTPUT_COMPLETE_FRAME}\n`)).toThrow('duplicate output transport completion')
    expect(() => decoder.push('YQ==\n')).toThrow('continued after completion')
    const truncated = new E2BBase64Decoder()
    truncated.push('YQ')
    expect(() => { truncated.finish() }).toThrow('truncated base64')
    expect(() => { new E2BBase64Decoder().finish() }).toThrow('incomplete output transport')
    const interrupted = new E2BBase64Decoder()
    interrupted.push('YQ')
    expect(() => { interrupted.finish(false) }).not.toThrow()
  })

  it('keeps a byte-exact tail with independent whole-stream cursors', () => {
    const reader = new E2BOutputReader(4, 10, '/remote/spill')
    reader.push(Buffer.alloc(0))
    reader.push(Buffer.from('ab'))
    reader.push(Buffer.from('cdef'))
    expect(reader.size).toBe(6)
    expect(reader.readFrom(0)).toEqual({ text: 'cdef', nextOffset: 6, lossy: true, spillPath: '/remote/spill' })
    expect(reader.readFrom(2)).toEqual({ text: 'cdef', nextOffset: 6, lossy: false })
    expect(reader.readFrom(5)).toEqual({ text: 'f', nextOffset: 6, lossy: false })
    expect(reader.readFrom(99)).toEqual({ text: '', nextOffset: 6, lossy: false })
    reader.invalidateSpill()
    expect(reader.readFrom(0)).toEqual({ text: 'cdef', nextOffset: 6, lossy: true })
  })

  it('drops whole head chunks and withholds absent or over-cap spills', () => {
    const withoutSpill = new E2BOutputReader(2, undefined, '/unused')
    withoutSpill.push(Buffer.from('ab'))
    withoutSpill.push(Buffer.from('cd'))
    expect(withoutSpill.readFrom(0)).toEqual({ text: 'cd', nextOffset: 4, lossy: true })
    const overCap = new E2BOutputReader(2, 3, '/too-small')
    overCap.push(Buffer.from('abcd'))
    expect(overCap.readFrom(0)).toEqual({ text: 'cd', nextOffset: 4, lossy: true })
  })
})

describe('E2BSubprocessHandle', () => {
  it('starts asynchronously, keeps secrets out of the command, and supports deferred piped stdin/output', async () => {
    const fake = new FakeSandbox()
    fake.processGroupId = '4343\n'
    fake.deferStart()
    const handle = testHandle(runtime(fake), spec({
      argv: ['tool', 'argument with spaces'],
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8, spill: { maxBytes: 32 } } },
      env: {
        PATH: '/bin',
        'FOO-BAR': 'hyphen-value',
        '--split-string': 'literal-value',
        DEEPSEEK_API_KEY: 'explicit-secret',
        DSH_MODE: 'test',
        // The seam's tombstone: an explicit undefined removes the ambient entry.
        KEEP: undefined,
      },
    }), '/workspace/.dsh-e2b/processes/one')
    expect(handle.pid).toBe(-1)
    handle.stdin!.write('hello')
    handle.stdin!.end()
    fake.releaseStart()
    await flush()
    expect(handle.pid).toBe(4343)
    expect(fake.handle.sent.map(value => String(value))).toEqual(['hello'])
    expect(fake.handle.closes).toBe(1)
    const controlEnvs = fake.startOptions?.envs
    expect(controlEnvs?.HOME).toMatch(/^\/\.dsh-e2b-control-/)
    expect(controlEnvs).toEqual({
      TERM: 'dumb',
      NPM_TOKEN: '',
      DSH_STALE: '',
      HOME: controlEnvs?.HOME,
    })
    const command = fake.commandsSeen.find(value => value.includes('exec "$dsh_e2b_env_bin" -i'))!
    expect(command).toContain('"$dsh_e2b_setsid" --wait -- "$dsh_e2b_bash" -c')
    expect(command).not.toContain('DEEPSEEK_API_KEY')
    expect(command).not.toContain('DSH_MODE')
    expect(command).not.toContain('FOO-BAR')
    expect(command).not.toContain('explicit-secret')
    expect(command).not.toContain('hyphen-value')
    expect(command).not.toContain('${!dsh_e2b_name}')
    const environmentProbe = fake.commandsSeen.find(value => value.includes('env -0 | base64'))
    expect(environmentProbe).toContain('getent passwd "$(id -u)"')
    expect(environmentProbe).toContain('test -n "$dsh_e2b_home" -a -d "$dsh_e2b_home"')
    expect(environmentProbe).not.toContain('"$PWD"')
    expect(command).toContain('mapfile -d')
    expect(command).toContain('dsh_e2b_node="$(command -v node)"')
    expect(command).toContain('"$dsh_e2b_env_bin" -i "$dsh_e2b_node" -e')
    expect(command).toContain('"$dsh_e2b_env_bin" -i -- "${dsh_e2b_env[@]}" "$@"')
    expect(command).toContain('exec "$dsh_e2b_env_bin" -i -- "${dsh_e2b_env[@]}"')
    expect(command).toContain('>&2 2>/dev/null')
    expect(command).not.toContain('2>/dev/null >&2')
    expect(command).toContain('base64')
    expect(fake.writtenFiles[0]).toEqual([
      '/workspace/.dsh-e2b/processes/one/pid',
      '/workspace/.dsh-e2b/processes/one/exit-code',
      '/workspace/.dsh-e2b/processes/one/environment',
      '/workspace/.dsh-e2b/processes/one/stderr.log',
    ])
    expect(fake.writtenFileData.get('/workspace/.dsh-e2b/processes/one/environment')).toBe(
      'PATH=/bin\0UNICODE=你好\0HOME=/home/user\0FOO-BAR=hyphen-value\0--split-string=literal-value\0DEEPSEEK_API_KEY=explicit-secret\0DSH_MODE=test\0',
    )

    let piped = ''
    handle.stdout!.on('data', (chunk) => { piped += String(chunk) })
    await fake.stdout('pipe-data')
    await fake.stderr('err')
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(piped).toBe('pipe-data')
    expect(handle.collected.stderr!.readFrom(0)).toMatchObject({ text: 'err', lossy: false })
    expect(fake.removed).toContain('/workspace/.dsh-e2b/processes/one/stderr.log')
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('rejects an unrepresentable graceMs before any remote work', () => {
    const ctx = new Context()
    const service = Object.create(E2BSubprocessRuntime.prototype) as E2BSubprocessRuntime
    Reflect.set(service, 'disposing', false)
    Reflect.set(service, 'ctx', ctx)
    for (const graceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => service.spawn(spec({ graceMs }))).toThrow('graceMs must be a positive finite number')
      void expect(service.spawnTerminal({
        argv: ['bash'], cwd: '/w', rows: 24, cols: 80, graceMs,
      })).rejects.toThrow('graceMs must be a positive finite number')
    }
  })

  it('rejects malformed environment entries before command start', async () => {
    for (const env of [{ 'BAD=NAME': 'x' }, { BAD: 'x\0INJECTED=1' }]) {
      const fake = new FakeSandbox()
      const handle = testHandle(runtime(fake), spec({ env }), '/runtime/invalid-environment')
      await expect(handle.done).rejects.toThrow('environment entries')
      expect(fake.startOptions).toBeUndefined()
      expect(fake.removed).toContain('/runtime/invalid-environment')
    }
  })

  it('preserves UTF-8 bytes when the ASCII transport is split across callbacks', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4 } },
    }), '/runtime/split-utf8')
    await flush()
    const chunks: Buffer[] = []
    handle.stdout!.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    for (const character of `${Buffer.from('A你好B').toString('base64')}\n`) {
      await fake.stdoutWire(character)
    }
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(Buffer.concat(chunks).toString('utf8')).toBe('A你好B')
  })

  it('rejects malformed output transport without confusing it with a consumer sink failure', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/malformed-output')
    await flush()
    await fake.stdoutWire('%\n')
    fake.finish()
    await expect(handle.done).rejects.toThrow('invalid base64 output transport')

    const stderrFake = new FakeSandbox()
    const stderrHandle = testHandle(runtime(stderrFake), spec(), '/runtime/malformed-stderr')
    await flush()
    await stderrFake.stderrWire('%\n')
    stderrFake.finish()
    await expect(stderrHandle.done).rejects.toThrow('invalid base64 output transport')
  })

  it('rejects a naturally completed command whose encoder omits its completion frame', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/incomplete-output')
    await flush()
    fake.alive = false
    fake.handle.succeed(0)
    await expect(handle.done).rejects.toThrow('incomplete output transport')
  })

  it('bounds descendant-held output draining and withholds the incomplete spill', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({ graceMs: 5 }), '/runtime/drain-bound')
    await flush()
    await fake.stdout('leader-output')
    fake.exitStatus = '0\n'

    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(fake.handle.disconnects).toBe(1)
    expect(handle.collected.stdout?.readFrom(0)).toEqual({
      text: 'tput',
      nextOffset: 13,
      lossy: true,
    })
    expect(fake.removed).toContain('/runtime/drain-bound/stdout.log')

    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('releases an inherited-output callback blocked on host backpressure at drain expiry', async () => {
    const fake = new FakeSandbox()
    const written: string[] = []
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: Uint8Array) => {
      written.push(Buffer.from(chunk).toString())
      return false
    }) as typeof process.stdout.write)
    try {
      const handle = testHandle(runtime(fake), spec({
        graceMs: 5,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: { maxBytes: 4 } },
      }), '/runtime/inherit-backpressure')
      await flush()
      let callbackSettled = false
      const blocked = fake.stdout('blocked bytes').then(() => { callbackSettled = true })
      await flush()
      expect(callbackSettled).toBe(false)
      fake.exitStatus = '0\n'

      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
      await blocked
      expect(callbackSettled).toBe(true)
      expect(written.join('')).toBe('blocked bytes')
      expect(fake.handle.disconnects).toBe(1)

      handle.terminate()
      await expect(handle.waitForExit()).resolves.toBe(true)
    } finally {
      stdoutWrite.mockRestore()
    }
  })

  it('waits for lossless raw-pipe output after the direct status is published', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      graceMs: 1,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4 } },
    }), '/runtime/pipe-drain')
    let output = ''
    handle.stdout!.on('data', (chunk) => { output += String(chunk) })
    await flush()
    fake.exitStatus = '0\n'

    let settled = false
    void handle.done.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    expect(fake.handle.disconnects).toBe(0)
    expect(fake.statusReads).toBe(0)

    await fake.stdout('complete protocol frame')
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(output).toBe('complete protocol frame')
    expect(fake.statusReads).toBe(1)
  })

  it('accepts clean encoder completion inside the output-drain grace', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({ graceMs: 100 }), '/runtime/drain-complete')
    await flush()
    fake.exitStatus = '0\n'
    fake.afterStatusRead = () => {
      fake.afterStatusRead = undefined
      setTimeout(() => { fake.finish() }, 0)
    }

    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(fake.handle.disconnects).toBe(0)
  })

  it('preserves a published exit code when requested termination outlives output draining', async () => {
    const fake = new FakeSandbox()
    fake.trapsTerm = true
    fake.delaysKill = true
    fake.delaysKillCompletion = true
    fake.sdkKillStops = false
    const handle = testHandle(runtime(fake), spec({ graceMs: 5 }), '/runtime/drain-signal')
    await flush()

    handle.terminate()
    await vi.waitFor(() => { expect(fake.commandsSeen).toContain('kill -KILL -- -4242') })
    fake.exitStatus = '0\n'

    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(fake.handle.disconnects).toBe(1)
    fake.alive = false
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('preserves a published nonzero exit code when termination settles the SDK inside the drain grace', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({ graceMs: 100 }), '/runtime/drain-signal-settled')
    await flush()
    fake.exitStatus = '7\n'
    fake.afterStatusRead = () => {
      fake.afterStatusRead = undefined
      handle.terminate()
    }

    await expect(handle.done).resolves.toEqual({ exitCode: 7, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('rejects an invalid direct-command exit status', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/invalid-status')
    await flush()
    fake.exitStatus = '999\n'
    await expect(handle.done).rejects.toThrow('invalid exit code')
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('rolls back a published process group before rejecting a monitoring failure', async () => {
    const fake = new FakeSandbox()
    fake.statusError = new Error('status transport failed')
    const handle = testHandle(runtime(fake), spec(), '/runtime/status-failure')

    await expect(handle.done).rejects.toThrow('status transport failed')
    expect(fake.commandsSeen).toContain('kill -TERM -- -4242')
    expect(fake.alive).toBe(false)
    await expect(handle.waitForExit()).resolves.toBe(true)

    const failed = new FakeSandbox()
    failed.statusError = new Error('status transport failed')
    failed.signalErrors.push(new Error('TERM transport failed'), new Error('KILL transport failed'))
    failed.handle.killError = new Error('SDK kill failed')
    const retained = testHandle(runtime(failed), spec({ graceMs: 1 }), '/runtime/status-cleanup-failure')

    await expect(retained.done).rejects.toThrow(
      'command monitoring failed and process-group rollback did not reach quiescence',
    )
    expect(failed.alive).toBe(true)
    failed.handle.killError = undefined
    retained.terminate()
    await expect(retained.waitForExit()).resolves.toBe(true)

    // A state-cleanup failure on top preserves the rollback failure instead of
    // re-aggregating only the original monitoring error.
    const triple = new FakeSandbox()
    triple.statusError = new Error('status transport failed')
    triple.signalErrors.push(new Error('TERM transport failed'), new Error('KILL transport failed'))
    triple.handle.killError = new Error('SDK kill failed')
    triple.nextRemoveError = new Error('state cleanup failed')
    const tripleHandle = testHandle(runtime(triple), spec({ graceMs: 1 }), '/runtime/triple-failure')
    const failure = await tripleHandle.done.catch((error: unknown) => error as AggregateError)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toContain('private state cleanup failed')
    const nested = (failure as AggregateError).errors[0] as AggregateError
    expect(nested.message).toContain('rollback did not reach quiescence')
    triple.handle.killError = undefined
    tripleHandle.terminate()
    await expect(tripleHandle.waitForExit()).resolves.toBe(true)
  })

  it('surfaces deferred piped-stdin write and close failures as stream errors', async () => {
    const writeFake = new FakeSandbox()
    writeFake.deferStart()
    vi.spyOn(writeFake.handle, 'sendStdin').mockRejectedValueOnce('stdin rejected')
    const writeHandle = testHandle(runtime(writeFake), spec({
      stdio: { stdin: 'pipe', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } },
    }), '/runtime/stdin-write-error')
    const writeError = once(writeHandle.stdin!, 'error')
    writeHandle.stdin!.write('input')
    writeFake.releaseStart()
    await expect(writeError).resolves.toMatchObject([{ message: 'stdin rejected' }])
    writeFake.finish()
    await writeHandle.done

    const closeFake = new FakeSandbox()
    vi.spyOn(closeFake.handle, 'closeStdin').mockRejectedValueOnce(new Error('close rejected'))
    const closeHandle = testHandle(runtime(closeFake), spec({
      stdio: { stdin: 'pipe', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } },
    }), '/runtime/stdin-close-error')
    await flush()
    const closeError = once(closeHandle.stdin!, 'error')
    closeHandle.stdin!.end()
    await expect(closeError).resolves.toMatchObject([{ message: 'close rejected' }])
    closeFake.finish()
    await closeHandle.done
  })

  it('collects bounded tails, retains valid spills, and maps natural nonzero exits', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      stdio: {
        stdin: { data: 'batch' },
        stdout: { maxBytes: 4, spill: { maxBytes: 16 } },
        stderr: { maxBytes: 3 },
      },
    }), '/runtime/two')
    await flush()
    await fake.stdout('abcdef')
    await fake.stderr('12345')
    fake.finish(7)
    await expect(handle.done).resolves.toEqual({ exitCode: 7, signal: null })
    expect(fake.handle.sent).toEqual(['batch'])
    expect(fake.handle.closes).toBe(1)
    expect(handle.collected.stdout!.readFrom(0)).toEqual({
      text: 'cdef',
      nextOffset: 6,
      lossy: true,
      spillPath: '/runtime/two/stdout.log',
    })
    expect(handle.collected.stderr!.readFrom(0)).toEqual({ text: '345', nextOffset: 5, lossy: true })
    expect(fake.removed).not.toContain('/runtime/two/stdout.log')
  })

  it('removes a spill once the complete stream exceeds its cap', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: { maxBytes: 2, spill: { maxBytes: 3 } }, stderr: 'inherit' },
    }), '/runtime/oversize')
    await flush()
    await fake.stdout('abcd')
    await fake.stderr('')
    fake.finish()
    await handle.done
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: 'cd', nextOffset: 4, lossy: true })
    expect(fake.removed).toContain('/runtime/oversize/stdout.log')
    const command = fake.commandsSeen.find(value => value.includes('dsh_e2b_tee='))!
    expect(command).toContain('"$dsh_e2b_head" -c 3')
    expect(command).toContain('/runtime/oversize/stdout.log')
    expect(command).toContain('"$dsh_e2b_tee" --output-error=warn-nopipe')
    expect(command).not.toContain('tee -a')
  })

  it('contains remote spill-removal failures and routes empty inherited output', async () => {
    const fake = new FakeSandbox()
    fake.nextRemoveError = new Error('already removed')
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: { maxBytes: 4, spill: { maxBytes: 8 } } },
    }), '/runtime/remove-error')
    await flush()
    await fake.stdout('')
    await fake.stderr('')
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(fake.removed).toContain('/runtime/remove-error/stderr.log')
  })

  it('terminates a process group with TERM and reports the signal outcome', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/term')
    await flush()
    handle.terminate()
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(fake.commandsSeen).toContain('kill -TERM -- -4242')
    expect(fake.commandsSeen).not.toContain('kill -KILL -- -4242')
    const signals = fake.commandsSeen.filter(command => command.startsWith('kill -')).length
    fake.alive = true
    handle.terminate()
    await flush()
    expect(fake.alive).toBe(true)
    expect(fake.commandsSeen.filter(command => command.startsWith('kill -'))).toHaveLength(signals)
  })

  it('makes termination a permanent no-op after natural quiescence is observed', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/natural-quiescence')
    await flush()
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)

    const signals = fake.commandsSeen.filter(command => command.startsWith('kill -')).length
    fake.alive = true
    handle.terminate()
    await flush()
    expect(fake.alive).toBe(true)
    expect(fake.commandsSeen.filter(command => command.startsWith('kill -'))).toHaveLength(signals)
  })

  it('treats a zombie-only process group as quiescent', async () => {
    const fake = new FakeSandbox()
    fake.zombieOnly = true
    const handle = testHandle(runtime(fake), spec(), '/runtime/zombie-quiescence')
    await flush()

    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(fake.commandsSeen).toContain(
      'set -o pipefail; ps -eo pgid=,stat= | awk \'$1 == 4242 && $2 !~ /^[ZXx]/ { live=1 } END { if (live) print "live" }\'',
    )
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('keeps proven quiescence after a concurrent termination transport fails', async () => {
    const fake = new FakeSandbox()
    fake.signalErrors.push(new Error('TERM transport failed'), new Error('KILL transport failed'))
    fake.handle.killError = new Error('SDK kill failed')
    fake.deferSignals()
    const handle = testHandle(runtime(fake), spec(), '/runtime/quiescent-race')
    await flush()

    handle.terminate()
    await vi.waitFor(() => { expect(fake.commandsSeen).toContain('kill -TERM -- -4242') })
    fake.alive = false
    await expect(handle.waitForExit()).resolves.toBe(true)

    fake.probeError = new Error('post-quiescence probe failed')
    fake.releaseSignals()
    await vi.waitFor(() => { expect(fake.handle.kills).toBe(1) })
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    const signals = fake.commandsSeen.filter(command => command.startsWith('kill -')).length
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(fake.commandsSeen.filter(command => command.startsWith('kill -'))).toHaveLength(signals)
  })

  it('escalates a TERM-trapping process group to KILL and uses the SDK kill as fallback', async () => {
    const fake = new FakeSandbox()
    fake.trapsTerm = true
    fake.handle.killError = new Error('already gone')
    const handle = testHandle(runtime(fake), spec({ graceMs: 1 }), '/runtime/kill')
    await flush()
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(fake.commandsSeen).toContain('kill -KILL -- -4242')
    expect(fake.handle.kills).toBe(1)
  })

  it('keeps force cleanup retryable until quiescence is proven', async () => {
    const fake = new FakeSandbox()
    fake.trapsTerm = true
    fake.delaysKill = true
    fake.delaysKillCompletion = true
    fake.sdkKillStops = false
    const handle = testHandle(runtime(fake), spec({ graceMs: 1 }), '/runtime/termination-fence')
    await flush()
    handle.terminate()
    await vi.waitFor(() => { expect(fake.handle.kills).toBe(1) })
    await expect(handle.waitForExit()).rejects.toThrow('remained live after force termination')
    expect(fake.alive).toBe(true)

    fake.delaysKill = false
    fake.delaysKillCompletion = false
    fake.sdkKillStops = true
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
  })

  it('honors termination requested before asynchronous startup finishes', async () => {
    const fake = new FakeSandbox()
    fake.deferStart()
    const handle = testHandle(runtime(fake), spec(), '/runtime/deferred-kill')
    handle.terminate()
    fake.releaseStart()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('aborts a stalled preparation request before reporting startup quiescence', async () => {
    const fake = new FakeSandbox()
    let preparationSignal: AbortSignal | undefined
    fake.environmentRequest = async (signal) => {
      preparationSignal = signal
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => {
          const reason: unknown = signal?.reason
          reject(reason instanceof Error ? reason : new Error(String(reason)))
        }
        if (signal?.aborted === true) {
          rejectAbort()
          return
        }
        signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    }
    const handle = testHandle(runtime(fake), spec(), '/runtime/stalled-preparation')
    await vi.waitFor(() => { expect(preparationSignal).toBeDefined() })

    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(preparationSignal?.aborted).toBe(true)
    expect(fake.startOptions).toBeUndefined()
  })

  it('kills through the provisional SDK handle before process-group publication', async () => {
    const fake = new FakeSandbox()
    fake.deferProcessGroupRead()
    fake.signalErrors.push(commandError(1), commandError(1))
    const handle = testHandle(runtime(fake), spec(), '/runtime/pre-publication-kill')
    await vi.waitFor(() => { expect(fake.startOptions).toBeDefined() })

    handle.terminate()
    await vi.waitFor(() => { expect(fake.handle.kills).toBe(1) })
    expect(fake.alive).toBe(false)
    await expect(handle.waitForExit()).resolves.toBe(true)

    fake.releaseProcessGroupRead()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
  })

  it('does not treat an unsuccessful SDK fallback as provisional group quiescence', async () => {
    const fake = new FakeSandbox()
    fake.deferProcessGroupRead()
    fake.trapsTerm = true
    fake.delaysKill = true
    fake.delaysKillCompletion = true
    fake.sdkKillStops = false
    fake.handle.killResult = false
    const handle = testHandle(runtime(fake), spec({ graceMs: 1 }), '/runtime/provisional-sdk-false')
    await vi.waitFor(() => { expect(fake.startOptions).toBeDefined() })

    handle.terminate()
    await vi.waitFor(() => { expect(fake.handle.kills).toBe(1) })
    await expect(handle.waitForExit()).rejects.toThrow('remained live after force termination')
    fake.alive = false
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    fake.releaseProcessGroupRead()
    fake.finish()
    await handle.done
  })

  it('bounds a quiescence observer while provisional termination is awaiting the controller', async () => {
    const fake = new FakeSandbox()
    fake.deferProcessGroupRead()
    const reconnect = Promise.withResolvers<Sandbox>()
    let calls = 0
    const delayedRuntime = runtime(fake, async () => {
      calls += 1
      return calls === 1 ? fake.sandbox : await reconnect.promise
    })
    const handle = testHandle(delayedRuntime, spec(), '/runtime/pre-publication-observer')
    await vi.waitFor(() => { expect(fake.startOptions).toBeDefined() })
    handle.terminate()

    const controller = new AbortController()
    const waiting = handle.waitForExit(controller.signal)
    await flush()
    controller.abort()
    await expect(waiting).resolves.toBe(false)

    reconnect.resolve(fake.sandbox)
    await expect(handle.waitForExit()).resolves.toBe(true)
    fake.releaseProcessGroupRead()
    await handle.done
  })

  it('proves a provisional group exit when the SDK kill fallback fails', async () => {
    const fake = new FakeSandbox()
    fake.deferProcessGroupRead()
    fake.trapsTerm = true
    fake.handle.killError = new Error('SDK kill unavailable')
    const handle = testHandle(runtime(fake), spec({ graceMs: 1 }), '/runtime/pre-publication-group-kill')
    await vi.waitFor(() => { expect(fake.startOptions).toBeDefined() })

    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    fake.releaseProcessGroupRead()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
  })

  it('reports failed provisional group and SDK force transports', async () => {
    const fake = new FakeSandbox()
    fake.deferProcessGroupRead()
    fake.signalErrors.push(new Error('TERM transport failed'), new Error('KILL transport failed'))
    fake.handle.killError = new Error('SDK kill failed')
    const handle = testHandle(runtime(fake), spec({ graceMs: 1 }), '/runtime/pre-publication-failure')
    await vi.waitFor(() => { expect(fake.startOptions).toBeDefined() })

    handle.terminate()
    await expect(handle.waitForExit()).rejects.toThrow('remained live after force termination')

    fake.handle.killError = undefined
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    fake.releaseProcessGroupRead()
    await handle.done

    const absentGroup = new FakeSandbox()
    absentGroup.deferProcessGroupRead()
    absentGroup.signalErrors.push(commandError(1), commandError(1))
    absentGroup.handle.killError = new Error('SDK kill failed without a provisional group')
    const absentHandle = testHandle(
      runtime(absentGroup),
      spec({ graceMs: 1 }),
      '/runtime/pre-publication-absent-group',
    )
    await vi.waitFor(() => { expect(absentGroup.startOptions).toBeDefined() })
    absentHandle.terminate()
    await expect(absentHandle.waitForExit()).rejects.toThrow('remained live after force termination')
    absentGroup.handle.killError = undefined
    absentHandle.terminate()
    await expect(absentHandle.waitForExit()).resolves.toBe(true)
    absentGroup.releaseProcessGroupRead()
    await absentHandle.done

    const optimisticSdk = new FakeSandbox()
    optimisticSdk.deferProcessGroupRead()
    optimisticSdk.signalErrors.push(commandError(1), commandError(1))
    optimisticSdk.sdkKillStops = false
    const optimisticHandle = testHandle(
      runtime(optimisticSdk),
      spec({ graceMs: 1 }),
      '/runtime/pre-publication-optimistic-sdk',
    )
    await vi.waitFor(() => { expect(optimisticSdk.startOptions).toBeDefined() })
    optimisticHandle.terminate()
    await expect(optimisticHandle.waitForExit()).rejects.toThrow('remained live after force termination')
    optimisticHandle.terminate()
    await expect(optimisticHandle.waitForExit()).resolves.toBe(true)
    optimisticSdk.releaseProcessGroupRead()
    await optimisticHandle.done
  })

  it('honors an already-aborted signal when constructing the asynchronous handle directly', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({ signal: AbortSignal.abort('stop') }), '/runtime/pre-aborted')
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('reacts to a signal that aborts after the remote command has started', async () => {
    const fake = new FakeSandbox()
    const controller = new AbortController()
    const handle = testHandle(runtime(fake), spec({ signal: controller.signal }), '/runtime/live-abort')
    await flush()
    controller.abort('stop')
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('can terminate a surviving process group after the command leader settles', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/surviving-group')
    await flush()
    await fake.completeOutput()
    fake.handle.succeed(0)
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(fake.alive).toBe(true)

    handle.terminate()
    await flush()
    const signaled = fake.commandsSeen.includes('kill -TERM -- -4242')
    if (!signaled) fake.finish()
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(signaled).toBe(true)
  })

  it('bounds waitForExit while startup or a live group is pending', async () => {
    const fake = new FakeSandbox()
    fake.deferStart()
    const handle = testHandle(runtime(fake), spec(), '/runtime/wait')
    const beforeStart = new AbortController()
    const pending = handle.waitForExit(beforeStart.signal)
    beforeStart.abort()
    await expect(pending).resolves.toBe(false)
    await expect(handle.waitForExit(AbortSignal.abort())).resolves.toBe(false)
    fake.releaseStart()
    await flush()
    const live = new AbortController()
    const liveWait = handle.waitForExit(live.signal)
    live.abort()
    await expect(liveWait).resolves.toBe(false)
    fake.finish()
    await handle.done

    const terminatingFake = new FakeSandbox()
    terminatingFake.deferStart()
    const terminating = testHandle(runtime(terminatingFake), spec(), '/runtime/wait-termination-start')
    terminating.terminate()
    const beforeHandle = new AbortController()
    const handlePending = terminating.waitForExit(beforeHandle.signal)
    beforeHandle.abort()
    await expect(handlePending).resolves.toBe(false)
    terminatingFake.releaseStart()
    await terminating.done
  })

  it('bounds both sides of the liveness-poll abort race', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/poll-abort')
    await flush()

    const beforeTick = new AbortController()
    fake.afterProbe = () => { beforeTick.abort(); fake.afterProbe = undefined }
    await expect(handle.waitForExit(beforeTick.signal)).resolves.toBe(false)

    const duringTick = new AbortController()
    fake.afterProbe = () => {
      fake.afterProbe = undefined
      setTimeout(() => { duringTick.abort() }, 0)
    }
    await expect(handle.waitForExit(duringTick.signal)).resolves.toBe(false)

    const duringProbe = new AbortController()
    fake.beforeProbe = () => { duringProbe.abort(); fake.beforeProbe = undefined }
    await expect(handle.waitForExit(duringProbe.signal)).resolves.toBe(false)

    let racedAbort = false
    const raceSignal = {
      get aborted() { return racedAbort },
      addEventListener: () => { racedAbort = true },
      removeEventListener: () => {},
    } as unknown as AbortSignal
    await expect(handle.waitForExit(raceSignal)).resolves.toBe(false)
    fake.finish()
    await handle.done
  })

  it('observes a live group across one successful bounded poll', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/poll-success')
    await flush()
    setTimeout(() => { fake.finish() }, 1)
    await expect(handle.waitForExit(new AbortController().signal)).resolves.toBe(true)
    await handle.done
  })

  it('treats startup failure as no live tree and contains readiness rejection', async () => {
    const fake = new FakeSandbox()
    fake.backgroundError = new Error('start failed')
    const handle = testHandle(runtime(fake), spec(), '/runtime/fail')
    await expect(handle.done).rejects.toThrow('start failed')
    expect(handle.pid).toBe(-1)
    expect(fake.removed).toContain('/runtime/fail/environment')
    expect(fake.removed).toContain('/runtime/fail')
    await expect(handle.waitForExit()).resolves.toBe(true)
    handle.terminate()

    const unavailableHandle = testHandle(
      runtime(new FakeSandbox(), async () => { throw new Error('sandbox unavailable') }),
      spec(),
      '/runtime/unavailable-start',
    )
    await expect(unavailableHandle.done).rejects.toThrow('sandbox unavailable')
    await expect(unavailableHandle.waitForExit()).resolves.toBe(true)

    const envFailure = new FakeSandbox()
    envFailure.envError = new Error('ambient lookup failed')
    const envHandle = testHandle(runtime(envFailure), spec(), '/runtime/env-failure')
    await expect(envHandle.done).rejects.toThrow('ambient lookup failed')
    expect(envFailure.removed).toEqual([])

    const expectEnvironmentFailure = async (name: string, wire: string, message: string): Promise<void> => {
      const fake = new FakeSandbox()
      fake.environmentWire = wire
      const failed = testHandle(runtime(fake), spec(), `/runtime/${name}`)
      await expect(failed.done).rejects.toThrow(message)
    }
    const encodedEnvironment = Buffer.from('PATH=/bin\0').toString('base64')
    const encodedHome = Buffer.from('/home/user').toString('base64')
    await expectEnvironmentFailure('malformed-frame', '%', 'invalid base64')
    await expectEnvironmentFailure('malformed-base64', `${encodedHome}\n%`, 'invalid base64')
    await expectEnvironmentFailure(
      'invalid-utf8-home',
      `${Buffer.from([0xff]).toString('base64')}\n${encodedEnvironment}`,
      'not valid UTF-8',
    )
    await expectEnvironmentFailure(
      'invalid-utf8-environment',
      `${encodedHome}\n${Buffer.from([0xff]).toString('base64')}`,
      'not valid UTF-8',
    )
    await expectEnvironmentFailure(
      'relative-home',
      `${Buffer.from('home/user').toString('base64')}\n${encodedEnvironment}`,
      'remote login home is invalid',
    )
    await expectEnvironmentFailure(
      'nul-home',
      `${Buffer.from('/home/user\0tail').toString('base64')}\n${encodedEnvironment}`,
      'remote login home is invalid',
    )

    const cleanupFailure = new FakeSandbox()
    cleanupFailure.backgroundError = new Error('start failed before credential consumption')
    cleanupFailure.nextRemoveError = new Error('credential cleanup failed')
    const cleanupHandle = testHandle(runtime(cleanupFailure), spec(), '/runtime/cleanup-failure')
    await expect(cleanupHandle.done).rejects.toThrow('command failed and private state cleanup failed')

    const absentState = new FakeSandbox()
    absentState.backgroundError = new Error('start failed after external cleanup')
    absentState.nextRemoveError = new FileNotFoundError('already removed')
    const absentHandle = testHandle(runtime(absentState), spec(), '/runtime/absent-state')
    await expect(absentHandle.done).rejects.toThrow('start failed after external cleanup')
  })

  it('bounds a readiness rejection with a still-live caller signal', async () => {
    const fake = new FakeSandbox()
    fake.deferStart()
    fake.backgroundError = new Error('start failed')
    const handle = testHandle(runtime(fake), spec(), '/runtime/fail-with-signal')
    const waiting = handle.waitForExit(new AbortController().signal)
    fake.releaseStart()
    await expect(handle.done).rejects.toThrow('start failed')
    await expect(waiting).resolves.toBe(true)
  })

  it('propagates an unavailable sandbox unless the caller aborts the wait', async () => {
    const fake = new FakeSandbox()
    let calls = 0
    const unavailable = runtime(fake, async () => {
      calls += 1
      if (calls === 1) return fake.sandbox
      throw new Error('connection unavailable')
    })
    const handle = testHandle(unavailable, spec(), '/runtime/unavailable')
    await flush()
    await expect(handle.waitForExit()).rejects.toThrow('connection unavailable')
    fake.finish()
    await handle.done
  })

  it('returns false when the caller aborts while reconnecting for liveness', async () => {
    const fake = new FakeSandbox()
    const reconnect = Promise.withResolvers<Sandbox>()
    let calls = 0
    const unavailable = runtime(fake, async () => {
      calls += 1
      return calls === 1 ? fake.sandbox : await reconnect.promise
    })
    const handle = testHandle(unavailable, spec(), '/runtime/reconnect-abort')
    await flush()
    const controller = new AbortController()
    const waiting = handle.waitForExit(controller.signal)
    await flush()
    controller.abort()
    reconnect.reject(new Error('connection unavailable'))
    await expect(waiting).resolves.toBe(false)
    fake.finish()
    await handle.done
  })

  it('returns false when a liveness request itself is aborted and surfaces other probe failures', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/probe')
    await flush()
    const controller = new AbortController()
    controller.abort()
    await expect(handle.waitForExit(controller.signal)).resolves.toBe(false)
    fake.probeError = new Error('probe failed')
    await expect(handle.waitForExit()).rejects.toThrow('probe failed')
    fake.finish()
    await handle.done
  })

  it('treats a timeout-killed sandbox as quiescent during liveness probing', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec(), '/runtime/expired-sandbox')
    await flush()
    fake.finish()
    await handle.done
    fake.probeError = new SandboxNotFoundError('sandbox expired')

    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('treats a missing sandbox handle as quiescent during liveness acquisition', async () => {
    const fake = new FakeSandbox()
    let calls = 0
    const handle = testHandle(runtime(fake, async () => {
      calls += 1
      if (calls === 1) return fake.sandbox
      throw new SandboxNotFoundError('sandbox expired')
    }), spec(), '/runtime/expired-acquisition')
    await flush()

    await expect(handle.waitForExit()).resolves.toBe(true)
    await fake.completeOutput()
    fake.alive = false
    fake.handle.succeed(0)
    await handle.done
  })

  it('treats sandbox loss during termination as quiescent', async () => {
    const fake = new FakeSandbox()
    let calls = 0
    const handle = testHandle(runtime(fake, async () => {
      calls += 1
      if (calls === 1) return fake.sandbox
      throw new SandboxNotFoundError('sandbox expired')
    }), spec(), '/runtime/expired-termination')
    await flush()
    await fake.completeOutput()

    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    fake.alive = false
    fake.handle.succeed(0)
    await handle.done
  })

  it('makes batch stdin close failures best-effort', async () => {
    const fake = new FakeSandbox()
    vi.spyOn(fake.handle, 'sendStdin').mockRejectedValueOnce(new Error('closed'))
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: { data: 'ignored' }, stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } },
    }), '/runtime/stdin-closed')
    await flush()
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('rejects malformed SDK process ids and non-command settlement failures', async () => {
    const invalidPid = new FakeSandbox()
    invalidPid.handle.pid = 0
    const invalid = testHandle(runtime(invalidPid), spec(), '/runtime/invalid-pid')
    await expect(invalid.done).rejects.toThrow(/invalid command pid 0/)
    expect(invalidPid.handle.kills).toBe(1)
    expect(invalidPid.removed).toContain('/runtime/invalid-pid/environment')
    await expect(invalid.waitForExit()).resolves.toBe(true)

    const failedRollback = new FakeSandbox()
    failedRollback.handle.pid = 0
    failedRollback.handle.killError = new Error('invalid handle kill failed')
    const retained = testHandle(runtime(failedRollback), spec(), '/runtime/invalid-pid-retained')
    await expect(retained.done).rejects.toThrow('invalid command pid rollback did not reach quiescence')
    await expect(retained.waitForExit()).rejects.toThrow('invalid handle kill failed')
    failedRollback.handle.killError = undefined
    retained.terminate()
    await expect(retained.waitForExit()).resolves.toBe(true)

    const crashedFake = new FakeSandbox()
    const crashed = testHandle(runtime(crashedFake), spec(), '/runtime/crashed')
    await flush()
    crashedFake.alive = false
    crashedFake.handle.crash(new Error('command transport failed'))
    await expect(crashed.done).rejects.toThrow('command transport failed')
  })

  it('rejects invalid or absent process-group publication', async () => {
    const invalidGroup = new FakeSandbox()
    invalidGroup.processGroupId = 'not-a-pid\n'
    invalidGroup.delaysKill = true
    invalidGroup.sdkKillStops = false
    invalidGroup.afterProbe = () => { invalidGroup.alive = false }
    const invalid = testHandle(runtime(invalidGroup), spec(), '/runtime/invalid-group')
    await expect(invalid.done).rejects.toThrow(/invalid process-group id/)
    expect(invalidGroup.handle.kills).toBe(1)
    expect(invalidGroup.commandsSeen).toContain('kill -KILL -- -4242')
    await expect(invalid.waitForExit()).resolves.toBe(true)

    // A rewritten pid file must not aim the kill at every process (`-- -1`).
    const unsafeGroup = new FakeSandbox()
    unsafeGroup.processGroupId = '1\n'
    unsafeGroup.delaysKill = true
    unsafeGroup.sdkKillStops = false
    unsafeGroup.afterProbe = () => { unsafeGroup.alive = false }
    const unsafe = testHandle(runtime(unsafeGroup), spec(), '/runtime/unsafe-group')
    await expect(unsafe.done).rejects.toThrow(/unsafe published process-group id 1/)
    expect(unsafeGroup.commandsSeen).not.toContain('kill -KILL -- -1')
    await expect(unsafe.waitForExit()).resolves.toBe(true)

    const absentGroup = new FakeSandbox()
    absentGroup.processGroupId = ''
    const absent = testHandle(runtime(absentGroup), spec(), '/runtime/absent-group')
    await flush()
    absentGroup.finish()
    await expect(absent.done).rejects.toThrow(/exited before publishing/)
    expect(absentGroup.handle.kills).toBe(1)
    expect(absentGroup.commandsSeen).toContain('kill -KILL -- -4242')
    await expect(absent.waitForExit()).resolves.toBe(true)
  })

  it('preserves publication failure and reports cleanup that cannot be verified', async () => {
    const fake = new FakeSandbox()
    fake.processGroupId = 'not-a-pid\n'
    fake.signalError = new Error('rollback signal failed')
    fake.handle.killError = new Error('SDK kill failed')
    const handle = testHandle(runtime(fake), spec(), '/runtime/failed-rollback')

    let failure: unknown
    try {
      await handle.done
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected AggregateError')
    expect(failure.message).toBe('subprocess-e2b: process-group publication failed and rollback did not reach quiescence')
    const failures = Array.from(failure.errors as Iterable<unknown>)
    expect(failures).toHaveLength(2)
    expect(failures[0]).toBeInstanceOf(Error)
    expect(failures[1]).toBeInstanceOf(Error)
    if (!(failures[0] instanceof Error) || !(failures[1] instanceof Error)) throw new Error('expected nested errors')
    expect(failures[0].message).toContain('invalid process-group id')
    expect(failures[1].message).toContain('remained live after force termination')
    expect(fake.handle.kills).toBe(1)
    const bounded = new AbortController()
    const waiting = handle.waitForExit(bounded.signal)
    bounded.abort()
    await expect(waiting).resolves.toBe(false)
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(fake.commandsSeen).toContain('kill -TERM -- -4242')

    const naturallyGone = new FakeSandbox()
    naturallyGone.processGroupId = 'not-a-pid\n'
    naturallyGone.signalError = new Error('rollback signal failed')
    naturallyGone.handle.killError = new Error('SDK kill failed')
    const observed = testHandle(runtime(naturallyGone), spec(), '/runtime/failed-rollback-observed')
    await expect(observed.done).rejects.toThrow('process-group publication failed')
    naturallyGone.alive = false
    await expect(observed.waitForExit()).resolves.toBe(true)
  })

  it('waits for delayed process-group publication', async () => {
    const fake = new FakeSandbox()
    fake.processGroupReads.push('', '4242\n')
    const handle = testHandle(runtime(fake), spec(), '/runtime/delayed-group')
    await vi.waitFor(() => { expect(handle.pid).toBe(4242) })
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('handles output backpressure and contains a stderr sink failure', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    }), '/runtime/backpressure')
    await flush()

    handle.stdout!.on('error', () => {})
    const stdoutWrite = vi.spyOn(handle.stdout!, 'write').mockReturnValueOnce(false)
    const stdoutPending = fake.stdout('blocked')
    queueMicrotask(() => { handle.stdout!.emit('drain') })
    await stdoutPending
    stdoutWrite.mockRestore()

    handle.stderr!.on('error', () => {})
    const stderrWrite = vi.spyOn(handle.stderr!, 'write').mockReturnValueOnce(false)
    const stderrPending = fake.stderr('broken')
    queueMicrotask(() => { handle.stderr!.emit('error', new Error('sink failed')) })
    await stderrPending
    stderrWrite.mockRestore()

    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('settles output backpressure when the consumer closes the pipe', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4 } },
    }), '/runtime/backpressure-close')
    await flush()

    const stdoutWrite = vi.spyOn(handle.stdout!, 'write').mockReturnValueOnce(false)
    const pending = fake.stdout('discarded')
    queueMicrotask(() => { handle.stdout!.destroy() })
    await pending
    stdoutWrite.mockRestore()

    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('breaks output backpressure when termination owns the command', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4 } },
    }), '/runtime/backpressure-termination')
    await flush()

    const stdoutWrite = vi.spyOn(handle.stdout!, 'write').mockReturnValueOnce(false)
    let released = false
    const pending = fake.stdout('blocked').then(() => { released = true })
    await Promise.resolve()
    handle.terminate()
    await flush()
    const releasedByTermination = released
    if (!released) handle.stdout!.emit('drain')
    await pending
    stdoutWrite.mockRestore()
    await handle.done

    expect(releasedByTermination).toBe(true)
  })

  it('settles backpressure when a synchronous pipe write starts termination', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4 } },
    }), '/runtime/backpressure-synchronous-termination')
    await flush()

    const stdoutWrite = vi.spyOn(handle.stdout!, 'write').mockImplementationOnce(() => {
      handle.terminate()
      return false
    })
    await expect(fake.stdout('blocked')).resolves.toBeUndefined()
    stdoutWrite.mockRestore()
    await handle.done
  })

  it('contains a pipe callback failure instead of rejecting command settlement', async () => {
    const fake = new FakeSandbox()
    const handle = testHandle(runtime(fake), spec({
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 4 } },
    }), '/runtime/pipe-error')
    await flush()
    const emitted = once(handle.stdout!, 'error')
    handle.stdout!.destroy(new Error('consumer failed'))
    await emitted
    await fake.stdout('late output')
    fake.finish()
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('contains an already-gone group signal and escalates after a TERM transport failure', async () => {
    const gone = new FakeSandbox()
    gone.trapsTerm = true
    gone.signalError = commandError(1)
    const goneHandle = testHandle(runtime(gone), spec({ graceMs: 1 }), '/runtime/gone-signal')
    await flush()
    goneHandle.terminate()
    await expect(goneHandle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })

    const failed = new FakeSandbox()
    failed.signalError = new Error('signal transport failed')
    const failedHandle = testHandle(runtime(failed), spec(), '/runtime/failed-signal')
    await flush()
    failedHandle.terminate()
    await expect(failedHandle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(failed.commandsSeen).toContain('kill -KILL -- -4242')
  })

  it('allows termination retry after both force transports fail', async () => {
    const fake = new FakeSandbox()
    fake.signalErrors.push(new Error('TERM transport failed'), new Error('KILL transport failed'))
    fake.handle.killError = new Error('SDK kill failed')
    const handle = testHandle(runtime(fake), spec({ graceMs: 1 }), '/runtime/retry-signal')
    await flush()

    handle.terminate()
    await expect(handle.waitForExit()).rejects.toThrow('remained live after force termination')
    fake.handle.killError = undefined
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(fake.commandsSeen.filter(command => command.startsWith('kill -TERM '))).toHaveLength(2)

    const missingGroup = new FakeSandbox()
    missingGroup.trapsTerm = true
    missingGroup.signalErrors.push(undefined, commandError(1))
    missingGroup.handle.killError = new Error('SDK kill failed after group exit race')
    const raced = testHandle(runtime(missingGroup), spec({ graceMs: 1 }), '/runtime/group-exit-race')
    await flush()
    raced.terminate()
    await expect(raced.waitForExit()).rejects.toThrow('remained live after force termination')
    missingGroup.handle.killError = undefined
    raced.terminate()
    await expect(raced.waitForExit()).resolves.toBe(true)
  })

  it('rejects an optimistic SDK kill while descendants survive a failed group KILL', async () => {
    const fake = new FakeSandbox()
    fake.trapsTerm = true
    fake.sdkKillStops = false
    fake.signalErrors.push(undefined, new Error('KILL transport failed'))
    const handle = testHandle(runtime(fake), spec({ graceMs: 1 }), '/runtime/optimistic-sdk-kill')
    await flush()

    handle.terminate()
    await expect(handle.waitForExit()).rejects.toThrow('remained live after force termination')
    expect(fake.alive).toBe(true)

    fake.sdkKillStops = true
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
  })
})

describe('E2BSubprocessRuntime', () => {
  async function service(
    fake = new FakeSandbox(),
    providedRuntime: E2BRuntime = runtime(fake),
  ): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
    const ctx = new Context()
    ctx.provide('e2b', providedRuntime)
    const fiber = await ctx.plugin(E2BSubprocessRuntime)
    return { ctx, fiber }
  }

  it('registers handles and disposal terminates and joins live remote groups regardless of sandbox policy', async () => {
    const fake = new FakeSandbox()
    fake.trapsTerm = true
    const { ctx, fiber } = await service(fake)
    const handle = ctx.subprocess.spawn(spec({ graceMs: 1 }))
    await flush()
    await fiber.dispose()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(fake.alive).toBe(false)
  })

  it('awaits SDK settlement after the remote process group becomes quiescent', async () => {
    const fake = new FakeSandbox()
    fake.trapsTerm = true
    const { ctx, fiber } = await service(fake)
    const handle = ctx.subprocess.spawn(spec())
    await flush()
    fake.alive = false

    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)

    fake.finish()
    await disposing
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('reports a failed termination transaction from disposal instead of waiting on done', async () => {
    const fake = new FakeSandbox()
    fake.signalErrors.push(new Error('TERM transport failed'), new Error('KILL transport failed'))
    fake.handle.killError = new Error('SDK kill failed')
    const { ctx, fiber } = await service(fake)
    const handle = ctx.subprocess.spawn(spec({ graceMs: 1 }))
    await flush()

    await expect(fiber.dispose()).resolves.toBeUndefined()
    await expect(handle.waitForExit()).rejects.toThrow('remained live after force termination')

    fake.handle.killError = undefined
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('aggregates sibling cleanup failures instead of reporting only the first', async () => {
    const { ctx, fiber } = await service()
    const disposalErrors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
    const first = {
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => { throw new Error('first cleanup failed') }),
      done: Promise.resolve({ exitCode: 0, signal: null }),
    } as unknown as E2BSubprocessHandle
    const second = {
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => { throw new Error('second cleanup failed') }),
      done: Promise.resolve({ exitCode: 0, signal: null }),
    } as unknown as E2BSubprocessHandle
    const live = (ctx.subprocess as unknown as { live: Set<E2BSubprocessHandle> }).live
    live.add(first)
    live.add(second)

    await fiber.dispose()
    const failure = disposalErrors[0]
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected AggregateError')
    expect(failure.errors.map(error => (error as Error).message).sort()).toEqual([
      'first cleanup failed',
      'second cleanup failed',
    ])
  })

  it('waits for every owned cleanup before reporting a disposal failure', async () => {
    const { ctx, fiber } = await service()
    const failed = {
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => { throw new Error('cleanup failed') }),
      done: Promise.resolve({ exitCode: 0, signal: null }),
    } as unknown as E2BSubprocessHandle
    let finishCleanup!: () => void
    const cleanup = new Promise<boolean>((resolve) => {
      finishCleanup = () => { resolve(true) }
    })
    const draining = {
      terminate: vi.fn(),
      waitForExit: vi.fn(() => cleanup),
      done: Promise.resolve({ exitCode: 0, signal: null }),
    } as unknown as E2BSubprocessHandle
    const live = (ctx.subprocess as unknown as { live: Set<E2BSubprocessHandle> }).live
    live.add(failed)
    live.add(draining)

    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await flush()
    expect(disposed).toBe(false)
    finishCleanup()
    await disposing
    expect(live).toEqual(new Set([failed]))
  })

  it('releases naturally settled handles before later service disposal', async () => {
    const fake = new FakeSandbox()
    const { ctx, fiber } = await service(fake)
    const handle = ctx.subprocess.spawn(spec())
    await flush()
    fake.finish()
    await handle.done
    await flush()
    const signalsBefore = fake.commandsSeen.filter(command => command.startsWith('kill -')).length
    await fiber.dispose()
    expect(fake.commandsSeen.filter(command => command.startsWith('kill -')).length).toBe(signalsBefore)
  })

  it('contains a release liveness failure and retries quiescence during disposal', async () => {
    const fake = new FakeSandbox()
    let calls = 0
    const reconnecting = runtime(fake, async () => {
      calls += 1
      if (calls === 2) throw new Error('transient liveness failure')
      return fake.sandbox
    })
    const { ctx, fiber } = await service(fake, reconnecting)
    const handle = ctx.subprocess.spawn(spec())
    await flush()
    fake.finish()
    await handle.done
    await flush()
    await fiber.dispose()
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('contains spawn rejection while disposal is joining the pending handle', async () => {
    const fake = new FakeSandbox()
    fake.deferStart()
    fake.backgroundError = new Error('start failed during disposal')
    const { ctx, fiber } = await service(fake)
    const subprocess = ctx.subprocess
    const handle = subprocess.spawn(spec())
    await vi.waitFor(() => { expect(fake.startOptions).toBeDefined() })
    const disposing = fiber.dispose()
    await flush()
    expect(() => subprocess.spawn(spec())).toThrow('service is disposing')
    fake.releaseStart()
    await expect(disposing).resolves.toBeUndefined()
    await expect(handle.done).rejects.toThrow('start failed during disposal')
  })

  it('validates synchronous spawn preconditions', async () => {
    const { ctx } = await service()
    expect(() => ctx.subprocess.spawn(spec({ argv: [] }))).toThrow(/non-empty program/)
    expect(() => ctx.subprocess.spawn(spec({ signal: AbortSignal.abort('stop') }))).toThrow(/aborted before spawn/)
  })
})
