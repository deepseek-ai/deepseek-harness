import type { RequestOptions } from 'node:http'
import type { AppUpdater } from 'electron-updater'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { describe, expect, it, vi } from 'vitest'
import {
  buildDesktopFeedHeaders,
  DesktopUpdateProvider,
  installDesktopUpdateProvider,
  resolveDesktopFeedArch,
  resolveDesktopFeedPlatform,
  type DesktopFeedMetadata,
} from '../src/updates/electron-updater/provider.ts'

describe('desktop feed metadata headers', () => {
  it('formats all non-secret source headers for macOS and Windows', () => {
    expect(buildDesktopFeedHeaders({
      configVersion: '1',
      channel: 'stable',
      channelSource: 'default',
      clientVersion: '0.2.3-rc.1.20261126.1',
      bundledDshVersion: '0.2.3-rc.1',
      platform: 'darwin',
      arch: 'arm64',
    }, '11111111-2222-5333-8444-555555555555')).toEqual({
      'x-dsh-config-version': '1',
      'x-client-update-channel': 'stable',
      'x-client-channel-source': 'default',
      'x-client-version': '0.2.3-rc.1.20261126.1',
      'x-client-bundled-dsh-version': '0.2.3-rc.1',
      'x-client-platform': 'desktop-mac',
      'x-client-arch': 'arm64',
      'x-client-device-id': '11111111-2222-5333-8444-555555555555',
    })

    expect(buildDesktopFeedHeaders({
      configVersion: '1',
      channel: 'nightly',
      channelSource: 'explicit',
      clientVersion: '0.2.3-rc.1',
      bundledDshVersion: '0.2.3-rc.1',
      platform: 'win32',
      arch: 'x64',
    }, 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee')).toEqual({
      'x-dsh-config-version': '1',
      'x-client-update-channel': 'nightly',
      'x-client-channel-source': 'explicit',
      'x-client-version': '0.2.3-rc.1',
      'x-client-bundled-dsh-version': '0.2.3-rc.1',
      'x-client-platform': 'desktop-win',
      'x-client-arch': 'x64',
      'x-client-device-id': 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
    })
  })

  it('rejects unsupported platforms and architectures instead of guessing wire names', () => {
    expect(() => resolveDesktopFeedPlatform('linux')).toThrow(/unsupported feed platform linux/u)
    expect(() => resolveDesktopFeedArch('ia32')).toThrow(/unsupported feed architecture ia32/u)
  })

  it('attaches live feed headers on metadata requests without reading disk config eagerly', async () => {
    const captured: RequestOptions[] = []
    const executor = {
      request: vi.fn(async (options: RequestOptions) => {
        captured.push(options)
        return 'version: 0.2.3-rc.2\nfiles:\n  - url: app.zip\n    sha512: ZmFrZQ==\n    size: 4\n'
      }),
    } as object as ElectronHttpExecutor
    let configReads = 0
    let metadata: DesktopFeedMetadata = {
      configVersion: '1',
      channel: 'stable',
      channelSource: 'default',
      clientVersion: '0.2.3-rc.1.20261126.1',
      bundledDshVersion: '0.2.3-rc.1',
      platform: 'darwin',
      arch: 'arm64',
    }
    const updater = {
      channel: 'stable',
      isAddNoCacheQuery: true,
      app: { whenReady: async () => {} },
      clientPromise: null as Promise<DesktopUpdateProvider> | null,
      get configOnDisk() {
        configReads++
        return { value: Promise.resolve({ provider: 'generic' as const, url: 'https://updates.example.com/feeds/mac-arm64/' }) }
      },
      stagingUserIdPromise: { value: Promise.resolve('device-uuid-1') },
      createProviderRuntimeOptions: () => ({ isUseMultipleRangeRequest: true, platform: 'darwin' as const, executor }),
      async getUpdateInfoAndProvider() {
        const provider = await this.clientPromise
        if (provider === null) throw new Error('missing provider')
        provider.setRequestHeaders({ 'x-user-staging-id': 'device-uuid-1' })
        return { info: await provider.getLatestVersion(), provider }
      },
    }
    installDesktopUpdateProvider(updater as object as AppUpdater, () => metadata)
    expect(configReads).toBe(0)

    const first = await updater.getUpdateInfoAndProvider()
    expect(configReads).toBe(1)
    expect(first.info.version).toBe('0.2.3-rc.2')
    expect(captured[0]?.path).toMatch(/^\/feeds\/mac-arm64\/stable-mac\.yml\?/u)
    expect(captured[0]?.headers).toEqual({
      'x-user-staging-id': 'device-uuid-1',
      'x-dsh-config-version': '1',
      'x-client-update-channel': 'stable',
      'x-client-channel-source': 'default',
      'x-client-version': '0.2.3-rc.1.20261126.1',
      'x-client-bundled-dsh-version': '0.2.3-rc.1',
      'x-client-platform': 'desktop-mac',
      'x-client-arch': 'arm64',
      'x-client-device-id': 'device-uuid-1',
    })

    updater.channel = 'nightly'
    metadata = { ...metadata, channel: 'nightly', channelSource: 'explicit' }
    await updater.getUpdateInfoAndProvider()
    expect(captured[1]?.path).toMatch(/^\/feeds\/mac-arm64\/nightly-mac\.yml\?/u)
    expect(captured[1]?.headers).toMatchObject({
      'x-dsh-config-version': '1',
      'x-client-update-channel': 'nightly',
      'x-client-channel-source': 'explicit',
      'x-client-device-id': 'device-uuid-1',
    })
  })
})
