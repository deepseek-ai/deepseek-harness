import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildWindowsSigningEnvironment,
  createRedactedWindowsSigningError,
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  repairDanglingAuthenticodeDirectory,
  scrubWindowsSigningEnvironment,
} from '../scripts/windows-sign.mjs'

vi.mock('node:crypto', () => ({
  X509Certificate: class {
    readonly ca = false
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
    expect(text).toContain('"%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% /tr http://timestamp.digicert.com /td sha256 "%targetFile%"\r\n')
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
