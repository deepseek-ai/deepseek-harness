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
    requests.push(path)
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
    await writeFile(config, 'updaterCacheDirName: cache\n')
    const adapter = { version: '1.0.0', name: 'channel-test', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: root, baseCachePath: root,
      whenReady: async () => {}, quit: forbidden, relaunch: forbidden, onQuit: forbidden }
    const Target = process.platform === 'darwin' ? updaterModule.MacUpdater : updaterModule.NsisUpdater
    const target = new Target(undefined, adapter)
    ownedUpdater = target
    target.logger = null
    target.autoDownload = false
    target.autoInstallOnAppQuit = false
    target.disableDifferentialDownload = true
    target.httpExecutor = new DesktopUpdateHttpExecutor(5000)
    target.setFeedURL({ provider: 'generic', url: origin })
    target.quitAndInstall = forbidden
    target.on('error', () => {}) // Awaited check/download promises report failures.
    selectUpdateChannel(target, 'nightly')
    assert.ok((await target.checkForUpdates()).updateInfo)
    assert.equal(requests.at(-1), `/nightly${process.platform === 'darwin' ? '-mac' : ''}.yml`)
    selectUpdateChannel(target, 'stable')
    await target.checkForUpdates()
    assert.equal(requests.at(-1), `/stable${process.platform === 'darwin' ? '-mac' : ''}.yml`)
    assert.equal(target.allowDowngrade, false)
    assert.equal(target.allowPrerelease, false)
    version = '0.9.0'
    await discardDesktopUpdate(target)
    await target.checkForUpdates()
    assert.equal(target.updateInfoAndProvider, null)
    version = '2.0.0'
    percentage = 0
    await discardDesktopUpdate(target)
    await target.checkForUpdates()
    assert.equal(target.updateInfoAndProvider, null)
    percentage = 100
    selectUpdateChannel(target, 'nightly')
    await target.checkForUpdates()
    assert.ok(target.updateInfoAndProvider)
    assert.equal(target.allowDowngrade, false)
    assert.equal(await target.isUserWithinRollout({ version: '2.0.0', stagingPercentage: 50 }),
      await target.isUserWithinRollout({ version: '2.0.0', stagingPercentage: 50 }))
    await target.downloadUpdate()
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
    version = '2.1.0'
    payload = Buffer.from('different release after obsolete cache survived')
    sha512 = createHash('sha512').update(payload).digest('base64')
    const recovered = new Target(undefined, adapter)
    ownedUpdater = recovered
    recovered.logger = null
    recovered.autoDownload = false
    recovered.autoInstallOnAppQuit = false
    recovered.disableDifferentialDownload = true
    recovered.httpExecutor = new DesktopUpdateHttpExecutor(5000)
    recovered.setFeedURL({ provider: 'generic', url: origin })
    recovered.quitAndInstall = forbidden
    recovered.on('error', () => {})
    selectUpdateChannel(recovered, 'stable')
    await recovered.checkForUpdates()
    await recovered.downloadUpdate()
    assert.deepEqual(await readFile(recovered.downloadedUpdateHelper.file), payload)
    assert.equal(recovered.downloadedUpdateHelper.versionInfo.version, '2.1.0')
    console.log('PASS: obsolete cache rejected by a new updater instance; current payload verified')
    console.log('PASS: real provider channel switching, rollout eligibility, real downloads, native platform cache and proxy retirement')
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
