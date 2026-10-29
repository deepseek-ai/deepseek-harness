import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopPurgeError, purgeDesktopInstaller } from '../scripts/desktop-edgeone.ts'
import { createDesktopUploadPlan, type DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { tagDesktopRelease } from '../scripts/desktop-release-tag.ts'
import { uploadDesktopRelease } from '../scripts/desktop-upload-run.ts'
import { runDesktopUploadCommand, uploadDesktopTarget } from '../scripts/upload-target.ts'

vi.mock('../scripts/desktop-edgeone.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/desktop-edgeone.ts')>(),
  purgeDesktopInstaller: vi.fn(),
}))

vi.mock('../scripts/desktop-package-environment.mjs', () => ({ loadDesktopPackageEnvironment: vi.fn() }))
vi.mock('../scripts/desktop-upload-plan.ts', () => ({ createDesktopUploadPlan: vi.fn() }))
vi.mock('../scripts/desktop-cos.ts', () => ({ createDesktopCos: vi.fn() }))
vi.mock('../scripts/desktop-upload-run.ts', () => ({ uploadDesktopRelease: vi.fn() }))
vi.mock('../scripts/desktop-release-tag.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/desktop-release-tag.ts')>(),
  tagDesktopRelease: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('desktop upload command', () => {
  it.each([
    { environment: 'production', latest: true, tagged: false },
    { environment: 'production', latest: false, tagged: true },
    { environment: 'test', latest: true, tagged: false },
    { environment: 'test', latest: false, tagged: false },
  ] as const)('uploads $environment latest=$latest with tagged=$tagged', async ({ environment, latest, tagged }) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const credentials = { ...productionEnvironment, DSH_DESKTOP_AUTO_UPDATE_ENV: environment, DOWNLOAD_TEST_COS_SECRET_ID: 'fixture-id', DOWNLOAD_TEST_COS_SECRET_KEY: 'fixture-key' }
    const plan: DesktopUploadPlan = {
      environment, target: 'win-x64', version: '1.2.3-alpha.4',
      publicUrl: 'https://desktop-updates.example.com/desktop/dsh-latest-windows-x64.exe',
      bucket: 'fixture-bucket', secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
      secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY', artifacts: [], commit: '0'.repeat(40), dirty: false,
    }
    vi.mocked(loadDesktopPackageEnvironment).mockReturnValue(credentials)
    vi.mocked(createDesktopUploadPlan).mockResolvedValue(plan)
    vi.mocked(uploadDesktopRelease).mockResolvedValue('fixture-records')
    vi.mocked(tagDesktopRelease).mockReturnValue({ status: 'created', tag: 'desktop-v1.2.3-alpha.4' })

    await uploadDesktopTarget(['win-x64', ...latest ? ['--latest'] : []])

    expect(createDesktopUploadPlan).toHaveBeenCalledWith('win-x64', { environment: credentials, latest })
    expect(uploadDesktopRelease).toHaveBeenCalledOnce()
    expect(vi.mocked(uploadDesktopRelease).mock.calls[0]![0]).toBe(plan)
    if (environment === 'production' && latest) {
      expect(purgeDesktopInstaller).toHaveBeenCalledWith(
        expect.objectContaining({ publicUrl: plan.publicUrl }),
      )
      expect(vi.mocked(purgeDesktopInstaller).mock.invocationCallOrder[0])
        .toBeGreaterThan(vi.mocked(uploadDesktopRelease).mock.invocationCallOrder[0]!)
    } else {
      expect(purgeDesktopInstaller).not.toHaveBeenCalled()
    }
    if (tagged) {
      expect(tagDesktopRelease).toHaveBeenCalledWith(expect.objectContaining({ version: plan.version, commit: plan.commit }))
      expect(vi.mocked(tagDesktopRelease).mock.invocationCallOrder[0])
        .toBeGreaterThan(vi.mocked(uploadDesktopRelease).mock.invocationCallOrder[0]!)
    }
    else {
      expect(tagDesktopRelease).not.toHaveBeenCalled()
    }
  })
})

const productionEnvironment = {
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DOWNLOAD_PROD_COS_BUCKET: 'fixture-bucket',
  DOWNLOAD_PROD_COS_SECRET_ID: 'fixture-id', DOWNLOAD_PROD_COS_SECRET_KEY: 'fixture-key', DOWNLOAD_PROD_EO_ZONE_ID: 'zone-fixture',
}

describe('cache-only submission command', () => {
  beforeEach(() => {
    vi.mocked(loadDesktopPackageEnvironment).mockReturnValue(productionEnvironment)
  })

  it('submits a purge without reading or uploading an installer', async () => {
    await uploadDesktopTarget(['--latest', '--purge-only', 'mac-arm64'])
    expect(createDesktopUploadPlan).not.toHaveBeenCalled()
    expect(uploadDesktopRelease).not.toHaveBeenCalled()
    expect(tagDesktopRelease).not.toHaveBeenCalled()
    expect(purgeDesktopInstaller).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      publicUrl: 'https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg',
    }))
  })

  it.each([[], ['win-x64', '--purge-only'], ['win-x64', '--latest', '--purge-only', '--job-id', 'job-1'], ['win-x64', '--latest', '--', '--purge-only']])('rejects invalid arguments %j before uploading', async (...args) => {
    await expect(uploadDesktopTarget(args)).rejects.toThrow()
    expect(uploadDesktopRelease).not.toHaveBeenCalled()
    expect(purgeDesktopInstaller).not.toHaveBeenCalled()
  })

  it('reports a completed upload when refresh fails, without tagging or repeating the upload', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.mocked(createDesktopUploadPlan).mockResolvedValue({
      environment: 'production', target: 'mac-arm64', version: '1.2.3', publicUrl: 'https://example.com/new-prefix/installer.dmg',
      bucket: 'fixture-bucket', secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID', secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY', artifacts: [],
    })
    vi.mocked(purgeDesktopInstaller).mockRejectedValue(new DesktopPurgeError('desktop purge: submission not confirmed'))
    await expect(uploadDesktopTarget(['mac-arm64', '--latest'])).rejects.toThrow('desktop purge: submission not confirmed')
    expect(output).toHaveBeenCalledWith('desktop upload: installer uploaded; submitting cache purge.\n')
    expect(uploadDesktopRelease).toHaveBeenCalledOnce()
    expect(purgeDesktopInstaller).toHaveBeenCalledOnce()
    expect(tagDesktopRelease).not.toHaveBeenCalled()
  })

  it.each([false, true])('reports safe purge diagnostics to the launcher-visible stream: launcher=%s', async (launcher) => {
    const previousExitCode = process.exitCode
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    vi.stubEnv('DSH_DESKTOP_AUTO_UPDATE_ENV', 'production')
    vi.stubEnv('DOWNLOAD_PROD_COS_BUCKET', 'fixture-bucket')
    vi.stubEnv('DOWNLOAD_PROD_COS_SECRET_ID', 'injected-id')
    vi.stubEnv('DOWNLOAD_PROD_COS_SECRET_KEY', 'injected-key')
    try {
      vi.mocked(purgeDesktopInstaller).mockRejectedValue(new DesktopPurgeError('desktop purge: safe recovery message'))
      await runDesktopUploadCommand(['mac-arm64', '--latest', '--purge-only', ...launcher ? ['--credential-launcher', '--environment', 'production', '--bucket', 'fixture-bucket'] : []])
      expect(launcher ? stdout : stderr).toHaveBeenCalledExactlyOnceWith('desktop purge: safe recovery message\n')
      expect(launcher ? stderr : stdout).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      expect(purgeDesktopInstaller).toHaveBeenCalledWith(expect.objectContaining({ secretId: launcher ? 'injected-id' : 'fixture-id' }))
    } finally {
      process.exitCode = previousExitCode
      vi.unstubAllEnvs()
    }
  })

  it('shows usage without referring to a nonexistent record for invalid arguments', async () => {
    const previousExitCode = process.exitCode
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      await runDesktopUploadCommand([])
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('record directory'))
    } finally {
      process.exitCode = previousExitCode
    }
  })
})
