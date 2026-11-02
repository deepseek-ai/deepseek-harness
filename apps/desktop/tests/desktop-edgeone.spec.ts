import { afterEach, describe, expect, it, vi } from 'vitest'
import { teo } from 'tencentcloud-sdk-nodejs-teo'
import { purgeDesktopInstaller, resolveDesktopPurgeConfig } from '../scripts/desktop-edgeone.ts'

const environment = {
  DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DOWNLOAD_PROD_COS_BUCKET: 'fixture-bucket',
  DOWNLOAD_PROD_COS_SECRET_ID: 'fixture-secret-id', DOWNLOAD_PROD_COS_SECRET_KEY: 'fixture-secret-key',
  DOWNLOAD_PROD_EO_ZONE_ID: 'zone-fixture',
}
const config = resolveDesktopPurgeConfig(environment, 'mac-arm64')

afterEach(() => vi.restoreAllMocks())

describe('production EdgeOne configuration', () => {
  it.each([
    [{ DSH_DESKTOP_AUTO_UPDATE_ENV: 'test' }, /production is required/u],
    [{ DSH_DESKTOP_AUTO_UPDATE_ENV: 'prod' }, /must be "test" or "production"/u],
    [{ DOWNLOAD_PROD_EO_ZONE_ID: '' }, /DOWNLOAD_PROD_EO_ZONE_ID/u],
    [{ DOWNLOAD_PROD_EO_ZONE_ID: 'invalid' }, /must name one EO zone/u],
    [{ DOWNLOAD_PROD_COS_SECRET_KEY: '' }, /DOWNLOAD_PROD_COS_SECRET_KEY/u],
  ] as const)('rejects invalid settings %j', (patch, message) => {
    expect(() => resolveDesktopPurgeConfig({ ...environment, ...patch }, 'mac-arm64')).toThrow(message)
  })

  it('uses the upload plan URL verbatim and derives only cache-only destinations', () => {
    const url = 'https://download.deepseek.com/changed/installer.dmg'
    expect(resolveDesktopPurgeConfig(environment, 'mac-arm64', url).publicUrl).toBe(url)
    expect(resolveDesktopPurgeConfig(environment, 'win-x64').publicUrl).toBe('https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe')
    expect(resolveDesktopPurgeConfig(environment, 'mac-x64').publicUrl).toBe('https://download.deepseek.com/desktop/dsh-latest-macos-x64.dmg')
  })
})

describe('EdgeOne purge submission', () => {
  it('submits once with the pinned SDK and reports acceptance without querying completion', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const submit = vi.spyOn(teo.v20220901.Client.prototype, 'CreatePurgeTask')
      .mockImplementation(async function (this: InstanceType<typeof teo.v20220901.Client>) {
        expect(this.profile.httpProfile).toMatchObject({ reqMethod: 'POST', protocol: 'https://', reqTimeout: 30 })
        return { JobId: 'job-1' }
      })
    const query = vi.spyOn(teo.v20220901.Client.prototype, 'DescribePurgeTasks').mockRejectedValue(new Error('must not query'))

    await purgeDesktopInstaller(config)

    expect(submit).toHaveBeenCalledExactlyOnceWith({ ZoneId: config.zoneId, Type: 'purge_url', Targets: [config.publicUrl] })
    expect(query).not.toHaveBeenCalled()
    expect(output).toHaveBeenCalledExactlyOnceWith(
      `desktop purge: submitted ${config.publicUrl}; task job-1. Cache completion is not checked.\n`,
    )
  })

  it('reports a rejected URL without printing the raw response or claiming acceptance', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const submit = vi.fn().mockResolvedValue({ JobId: 'job-1', FailedList: [{ Targets: [config.publicUrl], Reason: config.secretKey }] })
    await expect(purgeDesktopInstaller(config, { CreatePurgeTask: submit })).rejects.toThrow(
      'desktop purge: EO rejected the URL; inspect EO before submitting again.',
    )
    expect(submit).toHaveBeenCalledOnce()
    expect(output).not.toHaveBeenCalled()
  })

  it.each(['ECONNRESET', 'UnauthorizedOperation', undefined, config.secretKey])('does not retry or expose SDK errors (%s)', async (code) => {
    const submit = vi.fn().mockRejectedValue(Object.assign(new Error(config.secretKey), { code }))
    await expect(purgeDesktopInstaller(config, { CreatePurgeTask: submit })).rejects.toThrow(
      `desktop purge: submission not confirmed (${code === undefined || code === config.secretKey ? 'request failed' : code}); check EO task history and teo:CreatePurgeTask permission before submitting again.`,
    )
    expect(submit).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'unsafe value', config.secretId])('reports an unconfirmed submission without a usable task ID (%s)', async (jobId) => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const submit = vi.fn().mockResolvedValue({ JobId: jobId })
    await expect(purgeDesktopInstaller(config, { CreatePurgeTask: submit })).rejects.toThrow(
      'desktop purge: EO returned no task ID; check EO task history before submitting again.',
    )
    expect(submit).toHaveBeenCalledOnce()
    expect(output).not.toHaveBeenCalled()
  })
})
