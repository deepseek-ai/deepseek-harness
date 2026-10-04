import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopUploadPlan, type DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { tagDesktopRelease } from '../scripts/desktop-release-tag.ts'
import { uploadDesktopRelease } from '../scripts/desktop-upload-run.ts'
import { uploadDesktopTarget } from '../scripts/upload-target.ts'

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
    const credentials = { DOWNLOAD_TEST_COS_SECRET_ID: 'fixture-id', DOWNLOAD_TEST_COS_SECRET_KEY: 'fixture-key' }
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
