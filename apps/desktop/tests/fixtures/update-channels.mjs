/** Real updater channel/cache qualification with inert files; no installer is executed. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile, readFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import updaterModule from 'electron-updater'
import { DesktopUpdateCoordinator } from '../../lib/types/update-coordinator.js'
import { discardDesktopUpdate } from '../../lib/types/update-discard.js'
import { DesktopUpdateHttpExecutor } from '../../lib/types/update-http-executor.js'

async function main() {
  await app.whenReady()
  const root = process.env.DSH_CHANNEL_TEST_ROOT
  assert.ok(root)
  const requests = []
  let percentage
  const payload = Buffer.from('inert channel-switch qualification payload')
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0]
    requests.push(path)
    if (path === '/inert.exe' || path === '/inert.zip') {
      response.writeHead(200, { 'Content-Length': payload.length })
      response.end(payload)
      return
    }
    response.end(JSON.stringify({ version: '2.0.0', stagingPercentage: percentage,
      files: ['inert.exe', 'inert.zip'].map(url => ({ url, sha512, size: payload.length })) }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}/`
  const forbidden = () => { throw new Error('Installer execution is forbidden') }
  let coordinator
  try {
    const config = join(root, 'app-update.yml')
    await writeFile(config, 'updaterCacheDirName: cache\n')
    const adapter = { version: '1.0.0', name: 'channel-test', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: root, baseCachePath: root,
      whenReady: async () => {}, quit: forbidden, relaunch: forbidden, onQuit: forbidden }
    const updater = new updaterModule.NsisUpdater(undefined, adapter)
    updater.logger = null
    updater.httpExecutor = new DesktopUpdateHttpExecutor(5000)
    updater.setFeedURL({ provider: 'generic', url: origin, channel: 'nightly' })
    updater.quitAndInstall = forbidden
    coordinator = new DesktopUpdateCoordinator(state => state, async () => false,
      updater, () => true, () => '1.0.0')
    assert.equal((await coordinator.check(true)).phase, 'available')
    assert.equal(requests.at(-1), `/nightly${process.platform === 'darwin' ? '-mac' : ''}.yml`)
    await coordinator.switchChannel('latest', async () => {})
    assert.equal(requests.at(-1), `/latest${process.platform === 'darwin' ? '-mac' : ''}.yml`)
    assert.equal(updater.allowDowngrade, false)
    percentage = 0
    await coordinator.switchChannel('nightly', async () => {})
    assert.equal(coordinator.state.phase, 'idle')
    percentage = 100
    await coordinator.switchChannel('nightly', async () => {})
    assert.equal(coordinator.state.phase, 'available')
    assert.equal(await updater.isUserWithinRollout({ version: '2.0.0', stagingPercentage: 50 }),
      await updater.isUserWithinRollout({ version: '2.0.0', stagingPercentage: 50 }))

    const platforms = [updater]
    if (process.platform === 'darwin') {
      const mac = new updaterModule.MacUpdater(undefined, adapter)
      mac.logger = null
      mac.autoInstallOnAppQuit = false
      platforms.push(mac)
    }
    coordinator.dispose()
    for (const target of platforms) {
      target.httpExecutor = new DesktopUpdateHttpExecutor(5000)
      target.disableDifferentialDownload = true
      target.setFeedURL({ provider: 'generic', url: origin, channel: 'nightly' })
      target.quitAndInstall = forbidden
      coordinator = new DesktopUpdateCoordinator(state => state, async () => false,
        target, () => true, () => '1.0.0')
      assert.equal((await coordinator.check(true)).phase, 'available')
      const downloaded = await coordinator.download('2.0.0')
      assert.equal(downloaded.phase, 'ready', JSON.stringify(downloaded))
      const helper = target.downloadedUpdateHelper
      const file = helper.file
      assert.ok(file)
      assert.deepEqual(await readFile(file), payload)
      const proxy = target.server
      if (target instanceof updaterModule.MacUpdater) assert.equal(proxy.listening, true)
      const revision = coordinator.revision
      await coordinator.switchChannel('latest', async () => {})
      assert.equal(coordinator.state.phase, 'available')
      assert.equal(coordinator.selectedChannel, 'latest')
      if (proxy) assert.equal(proxy.listening, false)
      assert.equal(helper.file, null)
      assert.equal(helper.packageFile, null)
      await assert.rejects(access(file), { code: 'ENOENT' })
      // The same version in another channel cannot reuse the previous confirmation.
      await coordinator.download('2.0.0', revision)
      assert.equal(helper.file, null)
      await discardDesktopUpdate(target)
      assert.equal(target.updateInfoAndProvider, null)
      coordinator.dispose()
    }
    console.log('PASS: real provider channel switching, rollout eligibility, real downloads, NSIS cache retirement and available macOS proxy retirement')
  } finally {
    coordinator?.dispose()
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

  }

}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
