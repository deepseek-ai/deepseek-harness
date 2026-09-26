import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { createPackagingRun } from '../scripts/packaging-run.mjs'
import {
  buildWindowsSigningEnvironment,
  createRedactedWindowsSigningError,
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  repairDanglingAuthenticodeDirectory,
  scrubWindowsSigningEnvironment,
} from '../scripts/windows-sign.mjs'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const mock = vi.fn()
  // Node's execFile promisifier returns both output streams; generic promisify drops stderr.
  Object.defineProperty(mock, promisify.custom, { value: (...args: unknown[]) => new Promise((resolve, reject) => {
    mock(...args, (error: Error | null, stdout: string, stderr: string) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  }) })
  return { ...actual, execFile: mock }
})

vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  X509Certificate: class {
    readonly ca = false
    readonly fingerprint = 'A'.repeat(40)
    readonly keyUsage = ['1.3.6.1.5.5.7.3.3']

    constructor(contents: Buffer) {
      if (contents.toString('utf8') !== 'code-signing-certificate-fixture') {
        throw new Error('invalid test certificate')
      }
    }
  },
}))

const CERTIFICATE_FILE = 'C:\\release\\server.cer'
const SIGN_SCRIPT = resolve(import.meta.dirname, '../scripts/windows-sign.cmd')

describe('Windows token signing', () => {
  it.each(['invalid-primary', 'timestamp-exhausted', 'timestamp-recovered', 'normalization-corrupt'] as const)(
    'keeps hardware protection separate from %s', async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-sign-completion-'))
      const certificateFile = join(root, 'server.cer')
      const signTool = join(root, 'signtool.exe')
      const path = join(root, 'application.exe')
      const stateDirectory = join(root, 'state')
      await writeFile(certificateFile, 'code-signing-certificate-fixture')
      await writeFile(signTool, 'fixture')
      await writeFile(path, 'input')
      const run = createPackagingRun(join(root, 'records'), {})
      let hardware = 0
      let timestamps = 0
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const command = args[0] as string
        const argv = args[1] as string[]
        const options = args[2] as { env: NodeJS.ProcessEnv }
        const callback = args.at(-1) as (error: Error | null, stdout?: string, stderr?: string) => void
        if (argv[0] === '/d') {
          hardware++
          expect(existsSync(join(stateDirectory, 'attempt.json'))).toBe(true)
          writeFileSync(options.env.DSH_DESKTOP_WINDOWS_SIGN_TARGET!, 'signed:input')
          callback(null, '', '')
        } else {
          expect(options.env.DSH_DESKTOP_WINDOWS_TOKEN_PIN).toBeUndefined()
          expect(options.env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER).toBeUndefined()
          if (command === 'powershell.exe') {
            const timestamped = readFileSync(options.env.DSH_RUNTIME_VERIFY_FILE!, 'utf8').endsWith(':timestamp')
            if (!timestamped) expect(existsSync(join(stateDirectory, 'attempt.json'))).toBe(true)
            callback(null, JSON.stringify({ status: mode === 'invalid-primary' ? 'NotTrusted' : 'Valid', timestamped, thumbprint: 'A'.repeat(40) }), '')
          } else if (argv[0] === 'remove') {
            const target = argv.at(-1)!
            const content = readFileSync(target, 'utf8')
            if (mode === 'normalization-corrupt') writeFileSync(target, 'unexpected modification')
            else writeFileSync(target, content.replace(':timestamp', ''))
            if (mode === 'normalization-corrupt' || !content.endsWith(':timestamp')) {
              callback(Object.assign(new Error('normalization warning'), { code: 2 }))
            } else callback(null, '', '')
          } else {
            expect(argv[0]).toBe('timestamp')
            expect(existsSync(join(stateDirectory, 'attempt.json'))).toBe(false)
            const target = argv.at(-1)!
            expect(readFileSync(target, 'utf8')).toBe('signed:input')
            timestamps++
            if (mode === 'timestamp-exhausted' || timestamps === 1) {
              writeFileSync(target, 'failed partial output')
              callback(Object.assign(new Error('timestamp unavailable'), { code: 1, stderr: 'timestamp unavailable' }))
            } else {
              writeFileSync(target, 'signed:input:timestamp')
              callback(null, '', '')
            }
          }
        }
        return undefined as unknown as ReturnType<typeof execFile>
      })
      try {
        const sign = createWindowsTokenSigner({ certificateFile, signTool, tokenPin: 'fixture-pin', keyContainer: 'fixture-container',
          runDirectory: run.directory, stateDirectory })
        const task = { path, hash: 'sha256', isNest: false }
        if (mode === 'timestamp-recovered') {
          await sign(task)
          expect(await readFile(path, 'utf8')).toBe('signed:input:timestamp')
          expect(timestamps).toBe(2)
        } else {
          const results = await Promise.allSettled([sign(task), sign(task)])
          expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
          expect(await readFile(path, 'utf8')).toBe('input')
          expect(timestamps).toBe(mode === 'timestamp-exhausted' ? 3 : 0)
          expect(existsSync(join(run.directory, 'fatal.json'))).toBe(true)
        }
        expect(hardware).toBe(1)
        expect(existsSync(join(stateDirectory, 'attempt.json'))).toBe(mode === 'invalid-primary')
      } finally {
        vi.mocked(execFile).mockReset()
        await rm(root, { recursive: true, force: true })
      }
    }, 15_000,
  )
  it('preserves verified copies without hardware and rejects the entire queue after preservation failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-windows-copy-signature-'))
    try {
      const certificateFile = join(directory, 'server.cer')
      const signTool = join(directory, 'signtool.exe')
      await writeFile(certificateFile, 'code-signing-certificate-fixture')
      await writeFile(signTool, 'fixture')
      const preserveSignature = vi.fn(async () => true)
      const sign = createWindowsTokenSigner({ certificateFile, signTool, tokenPin: 'fixture-pin',
        keyContainer: 'fixture-container', preserveSignature })
      const task = { path: join(directory, 'copy.exe'), hash: 'sha256', isNest: false }
      await sign(task)
      expect(execFile).not.toHaveBeenCalled()
      preserveSignature.mockRejectedValueOnce(new Error('copy changed'))
      const results = await Promise.allSettled([sign(task), sign(task), sign(task)])
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
      expect(preserveSignature).toHaveBeenCalledTimes(2)
      expect(execFile).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops concurrent and subsequent signing tasks after a PIN failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-windows-pin-failure-'))
    try {
      const certificateFile = join(directory, 'server.cer')
      const signTool = join(directory, 'signtool.exe')
      const path = join(directory, 'application.exe')
      await writeFile(certificateFile, 'code-signing-certificate-fixture')
      await writeFile(signTool, 'fixture')
      await writeFile(path, 'fixture')
      validateDesktopPackageEnvironment({
        DSH_DESKTOP_APP_ID: 'com.example.desktop', DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
        DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
        DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
        DSH_DESKTOP_WINDOWS_CER_FILE: certificateFile, DSH_DESKTOP_WINDOWS_SIGNTOOL: signTool,
        DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin', DSH_DESKTOP_WINDOWS_KEY_CONTAINER: 'fixture-container',
        DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR: 'C:\\fixture\\signature-cache',
      }, { platform: 'win32', arch: 'x64' })
      expect(execFile).not.toHaveBeenCalled()
      vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error) => void
        callback(Object.assign(new Error('signing failed'), { stderr: 'SignTool Error: No private key is available.', code: 1 }))
        return undefined as unknown as ReturnType<typeof execFile>
      })
      const run = createPackagingRun(join(directory, 'records'), {})
      const options = { certificateFile, signTool, tokenPin: 'fixture-pin', keyContainer: 'fixture-container',
        runDirectory: run.directory, stateDirectory: join(directory, 'state') }
      const sign = createWindowsTokenSigner(options)
      const task = { path, hash: 'sha256', isNest: false }
      const results = await Promise.allSettled([sign(task), sign(task), sign(task)])
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
      await expect(sign(task)).rejects.toThrow('No private key is available.')
      const laterRun = createPackagingRun(join(directory, 'records'), {})
      await expect(createWindowsTokenSigner({ ...options, runDirectory: laterRun.directory })(task)).rejects.toThrow('interlock unavailable')
      expect(execFile).toHaveBeenCalledTimes(1)
      const records = await readFile(join(run.directory, 'events.jsonl'), 'utf8')
      expect(records).toContain('sign-start')
      expect(records).toContain('sign-failure')
      expect(records).not.toContain('fixture-pin')
      expect(await readFile(join(options.stateDirectory, 'attempt.json'), 'utf8')).toContain(run.directory.replaceAll('\\', '\\\\'))
    } finally {
      vi.mocked(execFile).mockReset()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('passes only the validated BAT fields to the signing command interpreter', () => {
    expect(buildWindowsSigningEnvironment({
      SystemRoot: 'C:\\Windows',
      DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'inherited-token-secret',
      DEEPSEEK_API_KEY: 'api-secret',
      BUILD_PASSWORD: 'build-secret',
    }, {
      certificateFile: CERTIFICATE_FILE,
      signTool: 'C:\\tools\\signtool.exe',
      path: 'C:\\release\\DeepSeek Harness.exe',
      isNest: false,
      tokenPin: 'token-secret!',
      keyContainer: 'te-container',
    })).toEqual({
      SystemRoot: 'C:\\Windows',
      DSH_DESKTOP_WINDOWS_SIGNTOOL: 'C:\\tools\\signtool.exe',
      DSH_DESKTOP_WINDOWS_CER_FILE: CERTIFICATE_FILE,
      DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'token-secret!',
      DSH_DESKTOP_WINDOWS_KEY_CONTAINER: 'te-container',
      DSH_DESKTOP_WINDOWS_SIGN_TARGET: 'C:\\release\\DeepSeek Harness.exe',
      DSH_DESKTOP_WINDOWS_SIGN_APPEND: '',
    })
  })

  it('requests an appended signature only for an electron-builder nested task', () => {
    expect(buildWindowsSigningEnvironment({}, {
      certificateFile: CERTIFICATE_FILE,
      signTool: 'C:\\tools\\signtool.exe',
      path: 'C:\\release\\setup.exe',
      isNest: true,
      tokenPin: 'token-secret!',
      keyContainer: 'te-container',
    }).DSH_DESKTOP_WINDOWS_SIGN_APPEND).toBe('1')
  })

  it('keeps the verified SafeNet command in an ASCII CRLF CMD file', async () => {
    const contents = await readFile(SIGN_SCRIPT)
    const text = contents.toString('ascii')
    expect(contents.every(byte => byte <= 0x7F)).toBe(true)
    expect(text).toContain('\r\n')
    expect(text.replaceAll('\r\n', '')).not.toContain('\n')
    expect(text).toContain('setlocal DisableDelayedExpansion\r\n')
    expect(text).toContain('set "DSH_DESKTOP_WINDOWS_CER_FILE="\r\n')
    expect(text).toContain('set "DSH_DESKTOP_WINDOWS_TOKEN_PIN="\r\n')
    expect(text).toContain('"%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% "%targetFile%"\r\n')
  })

  it('rejects incomplete signing identities and non-SHA-256 signing tasks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-windows-sign-tool-'))
    const certificateFile = join(directory, 'server.cer')
    const signTool = join(directory, 'signtool.exe')
    await writeFile(certificateFile, 'code-signing-certificate-fixture')
    await writeFile(signTool, 'fixture')
    expect(() => createWindowsTokenSigner({
      certificateFile: undefined,
      signTool,
      tokenPin: 'token-secret!',
      keyContainer: 'te-container',
    })).toThrow(/DSH_DESKTOP_WINDOWS_CER_FILE/u)
    expect(() => createWindowsTokenSigner({
      certificateFile,
      signTool: undefined,
      tokenPin: 'token-secret!',
      keyContainer: 'te-container',
    })).toThrow(/DSH_DESKTOP_WINDOWS_SIGNTOOL/u)
    const signer = createWindowsTokenSigner({
      certificateFile,
      signTool,
      tokenPin: 'token-secret!',
      keyContainer: 'te-container',
    })
    try {
      expect(() => createWindowsTokenSigner({
        certificateFile,
        signTool,
        tokenPin: 'token-secret!',
      })).toThrow(/DSH_DESKTOP_WINDOWS_KEY_CONTAINER/u)
      expect(() => createWindowsTokenSigner({
        certificateFile,
        signTool,
        tokenPin: '',
        keyContainer: 'te-container',
      })).toThrow(/DSH_DESKTOP_WINDOWS_TOKEN_PIN/u)
      expect(() => createWindowsTokenSigner({
        certificateFile,
        signTool,
        tokenPin: 'token]secret',
        keyContainer: 'te-container',
      })).toThrow(/cannot contain/u)
      await expect(signer({
        path: 'C:\\release\\setup.exe',
        hash: 'sha1',
        isNest: false,
      })).rejects.toThrow(/requires SHA-256/u)
      await expect(createWindowsTokenSigner({ certificateFile, signTool, tokenPin: 'fixture-pin', keyContainer: 'fixture-container' })({
        path: 'C:\\release\\setup.exe', hash: 'sha256', isNest: true,
      })).rejects.toThrow('does not support appended signatures')
    }
    finally {
      await rm(directory, { recursive: true })
    }
  })

  it('removes inherited credentials and redacts SignTool process failures', () => {
    expect(scrubWindowsSigningEnvironment({
      SystemRoot: 'C:\\Windows',
      DSH_DESKTOP_WINDOWS_CER_FILE: 'C:\\release\\server.cer',
      DSH_DESKTOP_WINDOWS_SIGNTOOL: 'C:\\tools\\signtool.exe',
      DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'token-secret',
      DEEPSEEK_API_KEY: 'api-secret',
      BUILD_PASSWORD: 'build-secret',
    })).toEqual({ SystemRoot: 'C:\\Windows' })

    const processError = Object.assign(new Error('failed'), {
      code: 1,
      cmd: 'signtool /kc [{{token-secret}}]=te-container',
      stderr: 'provider rejected token-secret',
    })
    const failure = createRedactedWindowsSigningError(
      processError,
      'C:\\release\\setup.exe',
      ['token-secret'],
    )
    expect(failure.message).toBe('Windows release signing failed for C:\\release\\setup.exe (exit 1): provider rejected <redacted>')
    expect(failure.message).not.toContain('token-secret')
    expect(failure).not.toHaveProperty('cause')
    expect(failure).not.toHaveProperty('cmd')
  })

  it('signs the temporary NSIS executable before enterprise policy evaluates it', async () => {
    const events: string[] = []
    let receivedEnvironment: NodeJS.ProcessEnv | undefined
    class FakeWineVmManager {
      async exec(
        file: string,
        _args: string[],
        options?: { env?: NodeJS.ProcessEnv },
      ): Promise<string> {
        events.push(`exec:${file}`)
        receivedEnvironment = options?.env
        return 'executed'
      }
    }
    installWindowsNsisBootstrapSigner({
      sign: async (configuration) => {
        events.push(`sign:${configuration.path}:${configuration.hash}:${String(configuration.isNest)}`)
      },
      wineVmManager: FakeWineVmManager,
      platform: 'win32',
      environment: {
        SystemRoot: 'C:\\Windows',
        DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'token-secret',
      },
    })

    const result = await new FakeWineVmManager().exec('C:\\release\\setup.exe', [], {
      env: {
        __COMPAT_LAYER: 'RunAsInvoker',
        BUILD_PASSWORD: 'build-secret',
      },
    })

    expect(result).toBe('executed')
    expect(events).toEqual([
      'sign:C:\\release\\setup.exe:sha256:false',
      'exec:C:\\release\\setup.exe',
    ])
    expect(receivedEnvironment).toEqual({
      SystemRoot: 'C:\\Windows',
      __COMPAT_LAYER: 'RunAsInvoker',
    })
  })

  it('clears a certificate table inherited beyond the generated uninstaller', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-windows-sign-'))
    const path = join(directory, 'uninstaller.exe')
    const executable = Buffer.alloc(512)
    const peOffset = 216
    const optionalHeaderOffset = peOffset + 24
    const certificateDirectoryOffset = optionalHeaderOffset + 96 + (4 * 8)
    executable.write('MZ', 0, 'ascii')
    executable.writeUInt32LE(peOffset, 60)
    executable.write('PE\0\0', peOffset, 'ascii')
    executable.writeUInt16LE(0x10B, optionalHeaderOffset)
    executable.writeUInt32LE(600, certificateDirectoryOffset)
    executable.writeUInt32LE(100, certificateDirectoryOffset + 4)
    await writeFile(path, executable)
    try {
      await expect(repairDanglingAuthenticodeDirectory(path)).resolves.toBe(true)
      const repaired = await readFile(path)
      expect(repaired.readUInt32LE(certificateDirectoryOffset)).toBe(0)
      expect(repaired.readUInt32LE(certificateDirectoryOffset + 4)).toBe(0)
      await expect(repairDanglingAuthenticodeDirectory(path)).resolves.toBe(false)
    }
    finally {
      await rm(directory, { recursive: true })
    }
  })
})
