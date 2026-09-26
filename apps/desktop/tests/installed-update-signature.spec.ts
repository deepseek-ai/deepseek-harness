import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installedUpdateFileHash, verifyInstalledUpdateSignature } from '../scripts/installed-update-signature.mjs'

type Execute = (command: string, args: string[], options: {
  env: NodeJS.ProcessEnv
  windowsHide: boolean
  timeout: number
  shell?: boolean
}) => Promise<{ stdout: string; stderr: string }>
const calls = vi.hoisted(() => ({ execute: vi.fn<Execute>() }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: calls.execute }) }
})

const details = { valid: true, timestamped: true, signer: 'A'.repeat(40), timestamp: 'B'.repeat(40) }
afterEach(() => { calls.execute.mockReset(); vi.unstubAllEnvs() })

async function fixture(body: (file: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-signature-read-'))
  try {
    const file = join(root, "inert ' executable.exe")
    await writeFile(file, 'inert bytes, never executed')
    await body(file, root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

function responses(): void {
  calls.execute.mockResolvedValueOnce({ stdout: '{"updaterVerificationInvoked":true}', stderr: '' })
    .mockResolvedValueOnce({ stdout: JSON.stringify(details), stderr: '' })
}

describe('installed update read-only signature evidence', () => {
  it('hashes actual bytes using the feed algorithm', async () => {
    await fixture(async (file) => {
      expect(await installedUpdateFileHash(file)).toBe(createHash('sha512').update(await readFile(file)).digest('base64'))
    })
  })

  it.runIf(process.platform !== 'win32')('refuses signature checks on non-Windows hosts without spawning', async () => {
    await fixture(async (file, root) => {
      await expect(verifyInstalledUpdateSignature(file, 'CN=Fixture', root)).rejects.toThrow('requires Windows')
      expect(calls.execute).not.toHaveBeenCalled()
    })
  })

  it.runIf(process.platform === 'win32')('isolates verification processes and records only public attributes for unchanged bytes', async () => {
    await fixture(async (file, root) => {
      vi.stubEnv('DSH_DESKTOP_WINDOWS_TOKEN_PIN', 'fixture-pin')
      vi.stubEnv('DOWNLOAD_TEST_COS_SECRET_KEY', 'fixture-key')
      vi.stubEnv('PSModulePath', 'incompatible-powershell-modules')
      vi.stubEnv('NODE_OPTIONS', '--require unused')
      responses()
      expect(await verifyInstalledUpdateSignature(file, 'CN=Fixture', root)).toEqual({
        sha512: await installedUpdateFileHash(file), valid: true, timestamped: true,
        signerThumbprint: details.signer, timestampThumbprint: details.timestamp, updaterVerificationInvoked: true,
      })
      expect(JSON.parse(await readFile(join(root, 'signature-config.json'), 'utf8'))).toEqual({ publisherName: ['CN=Fixture'] })
      expect(calls.execute.mock.calls[0]![0]).toBe(process.execPath)
      expect(calls.execute.mock.calls[0]![1]).toEqual([expect.stringMatching(/installed-update-signature\.mjs$/u), '--updater', join(root, 'signature-config.json'), file])
      expect(calls.execute.mock.calls[1]![0]).toBe('powershell.exe')
      expect(calls.execute.mock.calls[1]![1].join(' ')).not.toContain(file)
      for (const [, , options] of calls.execute.mock.calls) {
        const inheritedSecret = Object.keys(options.env)
          .some(name => /KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$|^PSModulePath$/iu.test(name))
        expect(inheritedSecret).toBe(false)
        expect(options).toMatchObject({ windowsHide: true, timeout: 60_000 })
        expect(options.shell).toBeUndefined()
      }
      expect(calls.execute.mock.calls[1]![2].env.DSH_VERIFY_FILE).toBe(file)
      expect(await readFile(file, 'utf8')).toBe('inert bytes, never executed')
      await expect(verifyInstalledUpdateSignature(file, 'CN=Fixture', root)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(calls.execute).toHaveBeenCalledTimes(2)
    })
  })

  it.runIf(process.platform === 'win32').each(['rejected', 'unconfirmed', 'malformed'])(
    'stops on an %s updater result without reading the timestamp', async (failure) => {
      await fixture(async (file, root) => {
        if (failure === 'rejected') calls.execute.mockRejectedValueOnce(new Error('signature rejected'))
        else calls.execute.mockResolvedValueOnce({ stdout: failure === 'malformed' ? 'not JSON' : '{}', stderr: '' })
        await expect(verifyInstalledUpdateSignature(file, 'CN=Fixture', root)).rejects.toThrow()
        expect(calls.execute).toHaveBeenCalledTimes(1)
      })
    })

  it.runIf(process.platform === 'win32').each([
    { ...details, valid: false }, { ...details, timestamped: false }, { ...details, signer: 'invalid' },
    { ...details, timestamp: null },
  ])('refuses invalid public signature attributes %j', async (invalid) => {
    await fixture(async (file, root) => {
      calls.execute.mockResolvedValueOnce({ stdout: '{"updaterVerificationInvoked":true}', stderr: '' })
        .mockResolvedValueOnce({ stdout: JSON.stringify(invalid), stderr: '' })
      await expect(verifyInstalledUpdateSignature(file, 'CN=Fixture', root)).rejects.toThrow('valid timestamped signature')
      expect(calls.execute).toHaveBeenCalledTimes(2)
    })
  })

  it.runIf(process.platform === 'win32')('rejects PowerShell errors even when stdout describes valid attributes', async () => {
    await fixture(async (file, root) => {
      calls.execute.mockResolvedValueOnce({ stdout: '{"updaterVerificationInvoked":true}', stderr: '' })
        .mockResolvedValueOnce({ stdout: JSON.stringify(details), stderr: 'module load failed' })
      await expect(verifyInstalledUpdateSignature(file, 'CN=Fixture', root)).rejects.toThrow('valid timestamped signature')
    })
  })

  it.runIf(process.platform === 'win32')('rejects a file changed while verification was running', async () => {
    await fixture(async (file, root) => {
      calls.execute.mockResolvedValueOnce({ stdout: '{"updaterVerificationInvoked":true}', stderr: '' })
        .mockImplementationOnce(async () => {
          await writeFile(file, 'changed bytes')
          return { stdout: JSON.stringify(details), stderr: '' }
        })
      await expect(verifyInstalledUpdateSignature(file, 'CN=Fixture', root)).rejects.toThrow('file changed')
    })
  })
})
