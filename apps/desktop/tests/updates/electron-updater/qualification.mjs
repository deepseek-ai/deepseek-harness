/** Real updater channel/cache qualification with inert files; no installer is executed. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile, readFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import updaterModule from 'electron-updater'
import { selectUpdateChannel } from '../../../lib/types/updates/electron-updater/channel.js'
import { discardDesktopUpdate } from '../../../lib/types/updates/electron-updater/discard.js'
import { DesktopUpdateHttpExecutor } from '../../../lib/types/updates/electron-updater/http-executor.js'
import {
  installDesktopUpdateProvider,
  resolveDesktopFeedArch,
  resolveDesktopFeedPlatform,
} from '../../../lib/types/updates/electron-updater/provider.js'

const FEED_HEADER_NAMES = [
  'x-dsh-config-version',
  'x-client-update-channel',
  'x-client-channel-source',
  'x-client-version',
  'x-client-bundled-dsh-version',
  'x-client-platform',
  'x-client-arch',
  'x-client-device-id',
]

async function main() {
  await app.whenReady()
  const root = process.env.DSH_CHANNEL_TEST_ROOT
  assert.ok(root)
  const requests = []
  let percentage
  let version = '2.0.0'
  let payload = Buffer.from('inert channel-switch qualification payload')
  let sha512 = createHash('sha512').update(payload).digest('base64')
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0]
    requests.push({ path, headers: request.headers })
    if (path === '/inert.exe' || path === '/inert.zip') {
      response.writeHead(200, { 'Content-Length': payload.length })
      response.end(payload)
      return
    }
    response.end(JSON.stringify({ version, stagingPercentage: percentage,
      files: ['inert.exe', 'inert.zip'].map(url => ({ url, sha512, size: payload.length })) }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}/`
  const forbidden = () => { throw new Error('Installer execution is forbidden') }
  let ownedUpdater
  try {
    const config = join(root, 'app-update.yml')
    await writeFile(config, `provider: generic\nurl: ${origin}\nchannel: stable\nupdaterCacheDirName: cache\n`)
    const adapter = { version: '1.0.0', name: 'channel-test', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: root, baseCachePath: root,
      whenReady: async () => {}, quit: forbidden, relaunch: forbidden, onQuit: forbidden }
    const Target = process.platform === 'darwin' ? updaterModule.MacUpdater : updaterModule.NsisUpdater
    const target = new Target(undefined, adapter)
    ownedUpdater = target
    let channel = 'stable'
    let channelSource = 'default'
    let configVersion = '1'
    target.logger = null
    target.autoDownload = false
    target.autoInstallOnAppQuit = false
    target.disableDifferentialDownload = true
    target.httpExecutor = new DesktopUpdateHttpExecutor(5000)
    installDesktopUpdateProvider(target, () => ({
      configVersion,
      channel,
      channelSource,
      clientVersion: adapter.version,
      bundledDshVersion: '0.2.3-alpha.2',
    }))
    target.quitAndInstall = forbidden
    target.on('error', () => {}) // Awaited check/download promises report failures.

    selectUpdateChannel(target, 'stable')
    assert.ok((await target.checkForUpdates()).updateInfo)
    const updaterId = (await readFile(join(root, '.updaterId'), 'utf8')).trim()
    assert.ok(updaterId.length > 0)
    const firstFeedRequest = requests.at(-1)
    assert.equal(firstFeedRequest.path, `/stable${process.platform === 'darwin' ? '-mac' : ''}.yml`)
    assert.equal(firstFeedRequest.headers['x-dsh-config-version'], '1')
    assert.equal(firstFeedRequest.headers['x-client-update-channel'], 'stable')
    assert.equal(firstFeedRequest.headers['x-client-channel-source'], 'default')
    assert.equal(firstFeedRequest.headers['x-client-version'], '1.0.0')
    assert.equal(firstFeedRequest.headers['x-client-bundled-dsh-version'], '0.2.3-alpha.2')
    assert.equal(firstFeedRequest.headers['x-client-platform'], resolveDesktopFeedPlatform())
    assert.equal(firstFeedRequest.headers['x-client-arch'], resolveDesktopFeedArch())
    assert.equal(firstFeedRequest.headers['x-client-device-id'], updaterId)
    assert.equal(firstFeedRequest.headers['x-user-staging-id'], updaterId)

    channel = 'nightly'
    channelSource = 'explicit'
    selectUpdateChannel(target, 'nightly')
    await discardDesktopUpdate(target)
    await target.checkForUpdates()
    const nightlyFeedRequest = requests.at(-1)
    assert.equal(nightlyFeedRequest.path, `/nightly${process.platform === 'darwin' ? '-mac' : ''}.yml`)
    assert.equal(nightlyFeedRequest.headers['x-dsh-config-version'], '1')
    assert.equal(nightlyFeedRequest.headers['x-client-update-channel'], 'nightly')
    assert.equal(nightlyFeedRequest.headers['x-client-channel-source'], 'explicit')
    assert.equal(nightlyFeedRequest.headers['x-client-device-id'], updaterId)

    channel = 'stable'
    selectUpdateChannel(target, 'stable')
    assert.equal(target.allowDowngrade, false)
    assert.equal(target.allowPrerelease, true)
    for (const candidate of ['2.0.0-alpha.1', '2.0.0-rc.1', '2.0.0']) {
      version = candidate
      await discardDesktopUpdate(target)
      assert.equal((await target.checkForUpdates()).isUpdateAvailable, true)
      assert.equal(target.updateInfoAndProvider.info.version, candidate)
    }
    for (const candidate of ['0.9.0-rc.1', '1.0.0-rc.1']) {
      version = candidate
      await discardDesktopUpdate(target)
      assert.equal((await target.checkForUpdates()).isUpdateAvailable, false)
      assert.equal(target.updateInfoAndProvider, null)
    }
    version = '2.0.0'
    percentage = 0
    await discardDesktopUpdate(target)
    await target.checkForUpdates()
    assert.equal(target.updateInfoAndProvider, null)
    percentage = 100
    channel = 'nightly'
    selectUpdateChannel(target, 'nightly')
    await target.checkForUpdates()
    assert.ok(target.updateInfoAndProvider)
    assert.equal(target.allowDowngrade, false)
    assert.equal(await target.isUserWithinRollout({ version: '2.0.0', stagingPercentage: 50 }),
      await target.isUserWithinRollout({ version: '2.0.0', stagingPercentage: 50 }))
    await target.downloadUpdate()
    const downloadRequest = requests.at(-1)
    assert.ok(downloadRequest.path === '/inert.exe' || downloadRequest.path === '/inert.zip')
    for (const header of FEED_HEADER_NAMES) {
      assert.equal(downloadRequest.headers[header], undefined, `Binary download must not carry ${header}`)
    }
    const helper = target.downloadedUpdateHelper
    const file = helper.file
    assert.ok(file)
    assert.deepEqual(await readFile(file), payload)
    const pending = helper.cacheDirForPendingUpdate
    const cachedInfo = await readFile(join(pending, 'update-info.json'))
    const oldPayload = Buffer.from(payload)
    const proxy = target.server
    if (process.platform === 'darwin') assert.equal(proxy.listening, true)
    await discardDesktopUpdate(target)
    channel = 'stable'
    selectUpdateChannel(target, 'stable')
    if (proxy) assert.equal(proxy.listening, false)
    assert.equal(helper.file, null)
    assert.equal(helper.packageFile, null)
    assert.equal(target.updateInfoAndProvider, null)
    await assert.rejects(access(file), { code: 'ENOENT' })
    await assert.rejects(target.downloadUpdate())
    // A later process can encounter files that a previous process could not remove.
    await writeFile(file, oldPayload)
    await writeFile(join(pending, 'update-info.json'), cachedInfo)
    version = '2.1.0-rc.1'
    payload = Buffer.from('different release after obsolete cache survived')
    sha512 = createHash('sha512').update(payload).digest('base64')
    const recovered = new Target(undefined, adapter)
    ownedUpdater = recovered
    recovered.logger = null
    recovered.autoDownload = false
    recovered.autoInstallOnAppQuit = false
    recovered.disableDifferentialDownload = true
    recovered.httpExecutor = new DesktopUpdateHttpExecutor(5000)
    installDesktopUpdateProvider(recovered, () => ({
      configVersion: '1',
      channel: 'stable',
      channelSource: 'default',
      clientVersion: adapter.version,
      bundledDshVersion: '0.2.3-alpha.2',
    }))
    recovered.quitAndInstall = forbidden
    recovered.on('error', () => {})
    selectUpdateChannel(recovered, 'stable')
    await recovered.checkForUpdates()
    assert.equal(requests.at(-1).headers['x-client-device-id'], updaterId)
    await recovered.downloadUpdate()
    for (const header of FEED_HEADER_NAMES) {
      assert.equal(requests.at(-1).headers[header], undefined, `Recovered binary download must not carry ${header}`)
    }
    assert.deepEqual(await readFile(recovered.downloadedUpdateHelper.file), payload)
    assert.equal(recovered.downloadedUpdateHelper.versionInfo.version, '2.1.0-rc.1')
    console.log('PASS: obsolete cache rejected by a new updater instance; current payload verified')
    console.log('PASS: real provider channel switching, feed headers, header-free downloads, rollout eligibility, and proxy retirement')
  } finally {
    try {
      if (ownedUpdater) await discardDesktopUpdate(ownedUpdater)
    } finally {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
