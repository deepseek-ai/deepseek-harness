/** Actual Electron download, checksum, Authenticode, and coordinator recovery; installer execution is forbidden. */
import assert from 'node:assert/strict'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import updaterModule from 'electron-updater'
import { DesktopUpdateCoordinator } from '../../lib/types/update-coordinator.js'
import { DesktopUpdateHttpExecutor } from '../../lib/types/update-http-executor.js'
import { resolveWindowsUpdatePublisher } from '../../scripts/windows-sign.mjs'
import { artifactDigest, createArtifactUpdateServer } from './artifact-update-server.mjs'

const root = process.env.DSH_SIGNED_UPDATE_TEST_ROOT
assert.ok(root, 'Launcher must supply a private test root')
app.setPath('userData', join(root, 'runtime', 'electron'))
const { NsisUpdater } = updaterModule
const report = { cases: [], installerExecuted: false, passed: false }

async function main() {
  await app.whenReady()
  const publisher = resolveWindowsUpdatePublisher(process.env.DSH_SIGNED_UPDATE_CERTIFICATE)
  const server = await createArtifactUpdateServer({
    signed: process.env.DSH_SIGNED_UPDATE_SIGNED,
    unsigned: process.env.DSH_SIGNED_UPDATE_UNSIGNED,
    ...(process.env.DSH_SIGNED_UPDATE_OLD ? {
      old: process.env.DSH_SIGNED_UPDATE_OLD,
      oldBlockmap: `${process.env.DSH_SIGNED_UPDATE_OLD}.blockmap`,
      signedBlockmap: `${process.env.DSH_SIGNED_UPDATE_SIGNED}.blockmap`,
    } : {}),
  })
  report.inputs = server.artifacts
  report.publisherName = publisher
  report.simulatedInstalledVersion = '1.0.0'
  report.syntheticFeedVersion = '1.0.1-nightly.1'
  const fixtures = []
  let installed = 0
  async function fixture(expectedPublisher = publisher, differential = false, multipleRanges = true) {
    const directory = join(root, 'runtime', `case-${fixtures.length}`)
    await mkdir(directory)
    const config = join(directory, 'app-update.yml')
    await writeFile(config, JSON.stringify({ publisherName: [expectedPublisher], updaterCacheDirName: 'cache' }))
    const forbidden = () => { throw new Error('Unexpected application quit or relaunch') }
    const updater = new NsisUpdater(undefined, {
      version: '1.0.0', name: 'signed-download-qualification', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: directory, baseCachePath: directory,
      whenReady: async () => {}, quit: forbidden, relaunch: forbidden, onQuit: forbidden,
    })
    const logs = []
    const errors = []
    const states = []
    updater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, value => logs.push(String(value))]))
    updater.httpExecutor = new DesktopUpdateHttpExecutor(60_000)
    updater.disableDifferentialDownload = !differential
    updater.disableWebInstaller = true
    updater.setFeedURL({ provider: 'generic', url: server.url, channel: 'nightly', useMultipleRangeRequest: multipleRanges })
    updater.on('error', error => errors.push(error.code))
    updater.quitAndInstall = () => { installed++ }
    let authorized = false
    const coordinator = new DesktopUpdateCoordinator(state => { states.push(state); return state },
      async () => authorized, updater, () => true, () => '1.0.0')
    const f = { coordinator, updater, logs, errors, states, directory, authorize: () => { authorized = true } }
    fixtures.push(f)
    return f
  }
  async function download(f) {
    const count = server.requests.length
    assert.equal((await f.coordinator.check(true)).phase, 'available')
    assert.equal(server.requests.length - count, 1, 'Checking must not download')
    assert.equal(server.requests.at(-1).path, '/nightly.yml')
    return f.coordinator.download('1.0.1-nightly.1')
  }
  async function rejected(f, code) {
    const state = await download(f)
    assert.equal(state.phase, 'error')
    assert.equal(state.failedOperation, 'download')
    assert.ok(f.errors.includes(code), `Expected updater rejection ${code}, received ${f.errors}`)
    assert.ok(!f.states.some(item => item.phase === 'ready'))
    await assert.rejects(f.coordinator.install('1.0.1-nightly.1'), /not ready/u)
    const cache = await readdir(join(f.directory, 'cache'), { recursive: true })
    assert.ok(!cache.some(file => file.endsWith('.exe')), 'Rejected executables must be removed from cache')
    const count = server.requests.length
    await f.coordinator.check()
    assert.equal(server.requests.length, count, 'Automatic checks must not retry rejected downloads')
    assert.equal(installed, 0)
  }
  try {
    server.select('signed')
    const wrong = await fixture('CN=Not the release publisher')
    await rejected(wrong, 'ERR_UPDATER_INVALID_SIGNATURE')
    report.cases.push('valid-hash-wrong-publisher-rejected-and-cleared')

    server.select('unsigned')
    const unsigned = await fixture()
    await rejected(unsigned, 'ERR_UPDATER_INVALID_SIGNATURE')
    report.cases.push('valid-hash-unsigned-rejected-and-cleared')

    server.select('signed', true)
    const corrupt = await fixture()
    await rejected(corrupt, 'ERR_CHECKSUM_MISMATCH')
    assert.ok(!corrupt.logs.some(line => line.startsWith('Verifying signature ')), 'Corrupt bytes must fail before signature verification')
    report.cases.push('corrupt-transfer-rejected-before-signature')

    server.select('signed')
    assert.equal((await download(unsigned)).phase, 'ready')
    assert.equal(await artifactDigest(unsigned.updater.installerPath), server.artifacts.signed.sha512)
    assert.ok(unsigned.states.some(state => state.phase === 'verifying'))
    assert.ok(unsigned.logs.some(line => line.startsWith('Verifying signature ')))
    const count = server.requests.length
    await unsigned.coordinator.check(true)
    await unsigned.coordinator.download('1.0.1-nightly.1')
    assert.equal(server.requests.length, count, 'Prepared targets must not download again')
    assert.equal(installed, 0)
    assert.equal((await unsigned.coordinator.install('1.0.1-nightly.1')).phase, 'ready')
    assert.equal(installed, 0)
    unsigned.authorize()
    assert.equal((await unsigned.coordinator.install('1.0.1-nightly.1')).phase, 'installing')
    assert.equal(installed, 1, 'Installation handoff requires separate approval')
    report.cases.push('explicit-retry-signed-ready-and-separate-install-handoff')
    if (server.artifacts.old) {
      report.differential = []
      for (const [name, multipleRanges, fault] of [
        ['multipart-range-reconstruction', true],
        ['single-range-reconstruction', false],
        ['missing-old-blockmap-full-fallback', true, 'missing-old-blockmap'],
        ['rejected-range-full-fallback', true, 'reject-ranges'],
      ]) {
        const f = await fixture(publisher, true, multipleRanges)
        await mkdir(join(f.directory, 'cache'))
        await copyFile(server.artifacts.old.file, join(f.directory, 'cache', 'installer.exe'))
        server.select('signed', false, fault)
        const start = server.requests.length
        assert.equal((await download(f)).phase, 'ready')
        assert.equal(await artifactDigest(f.updater.installerPath), server.artifacts.signed.sha512)
        assert.ok(f.logs.some(line => line.startsWith('Verifying signature ')))
        assert.equal(installed, 1, 'Download must not invoke another installer handoff')
        const requests = server.requests.slice(start)
        const payload = requests.filter(request => request.path.endsWith('.exe'))
        const fallback = f.logs.some(line => line.includes('fallback to full download'))
        assert.ok(requests.some(request => request.path.endsWith('1.0.0.exe.blockmap')))
        assert.ok(requests.some(request => request.path.endsWith('1.0.1-nightly.1.exe.blockmap')))
        if (!fault) {
          assert.equal(fallback, false, 'A full fallback cannot pass differential qualification')
          assert.ok(payload.length > 0 && payload.every(request => request.range))
          assert.equal(payload.some(request => request.range.includes(',')), multipleRanges)
          assert.ok(payload.reduce((bytes, request) => bytes + request.bytes, 0) < server.artifacts.signed.size,
            'Reconstruction must reuse bytes from the cached installer')
        }
        else {
          assert.equal(fallback, true)
          assert.equal(payload.filter(request => !request.range).length, 1)
          assert.equal(payload.at(-1).bytes, server.artifacts.signed.size)
          if (fault === 'reject-ranges') assert.ok(payload.some(request => request.range))
        }
        report.differential.push({ name, requests, fallback,
          payloadBytes: payload.reduce((bytes, request) => bytes + request.bytes, 0),
          fullSize: server.artifacts.signed.size })
        report.cases.push(name)
      }
    }
    assert.ok(fixtures.every(f => !f.logs.some(line => line.includes('Ignoring signature validation'))))
    assert.deepEqual(server.failures, [])
    for (const artifact of Object.values(server.artifacts)) assert.equal(await artifactDigest(artifact.file), artifact.sha512)
    report.passed = true
  }
  finally {
    for (const f of fixtures) f.coordinator.dispose()
    await server.close()
    report.requests = server.requests
    report.fixtures = fixtures.map(f => ({ errors: f.errors, phases: f.states.map(state => state.phase) }))
    await writeFile(join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
}

main().then(() => app.exit(0), async (error) => {
  console.error(error)
  await writeFile(join(root, 'failure.txt'), `${error.stack ?? error}\n`)
  app.exit(1)
})
