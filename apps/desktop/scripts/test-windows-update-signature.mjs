/** Real NSIS publisher verification against supplied files; never signs or executes an installer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWindowsUpdatePublisher } from './windows-sign.mjs'

assert.equal(process.platform, 'win32', 'Authenticode qualification requires Windows')
const [certificateFile, signedFile, unsignedFile] = process.argv.slice(2)
assert.ok(certificateFile && signedFile && unsignedFile,
  'Usage: node apps/desktop/scripts/test-windows-update-signature.mjs <public.cer> <signed.exe> <unsigned.exe>')
const require = createRequire(import.meta.url)
const { NsisUpdater } = require('electron-updater')
const { WindowsSignToolManager } = require('app-builder-lib/out/codeSign/windowsSignToolManager.js')
const { getAppUpdatePublishConfiguration } = require('app-builder-lib/out/publish/PublishManager.js')
const { Platform } = require('app-builder-lib')
const publisherName = resolveWindowsUpdatePublisher(certificateFile)
const signed = await realpath(signedFile)
const unsigned = await realpath(unsignedFile)
assert.notEqual(signed, unsigned, 'Signed and unsigned controls must be distinct files')
const qualification = fileURLToPath(new URL('../.desktop-build/qualification/', import.meta.url))
await mkdir(qualification, { recursive: true })
const root = await mkdtemp(join(qualification, 'windows-update-signature-'))
const report = { publisherName, installerExecuted: false, cases: [], passed: false }

async function digest(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

try {
  const before = { signed: await digest(signed), unsigned: await digest(unsigned) }
  const platformSpecificBuildOptions = { signtoolOptions: { publisherName } }
  const manager = new WindowsSignToolManager({ platformSpecificBuildOptions })
  // Keep builder/updater metadata code real; no packaging, key lookup, HTTP, or installer entry runs.
  const metadata = await getAppUpdatePublishConfiguration({
    platform: Platform.WINDOWS,
    platformSpecificBuildOptions,
    appInfo: { updaterCacheDirName: 'private-signature-qualification' },
    signingManager: { value: Promise.resolve(manager) },
    isForceCodeSigningVerification: true,
    info: {},
    config: { publish: [{ provider: 'generic', url: 'https://unused.invalid/', channel: 'nightly' }] },
    expandMacro: value => value,
  }, null, 1, true)
  assert.deepEqual(metadata.publisherName, [publisherName])
  for (const [name, file, config, accepted] of [
    ['missing-publisher-negative-control', signed, { ...metadata, publisherName: undefined }, true],
    ['matching-publisher', signed, metadata, true],
    ['wrong-publisher', signed, { ...metadata, publisherName: ['CN=Not the release publisher'] }, false],
    ['unsigned-file', unsigned, metadata, false],
  ]) {
    const configFile = join(root, `${name}.yml`)
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
    const updater = new NsisUpdater(null, { version: '0.1.0', isPackaged: true })
    updater.autoInstallOnAppQuit = false
    updater.updateConfigPath = configFile
    const logs = []
    updater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, value => logs.push(String(value))]))
    const result = await updater.verifySignature(file)
    assert.equal(result === null, accepted, `${name}: unexpected signature result`)
    assert.ok(!logs.some(line => line.includes('Ignoring signature validation')), 'PowerShell verification must not be skipped')
    const verificationInvoked = logs.some(line => line.startsWith('Verifying signature '))
    assert.equal(verificationInvoked, name !== 'missing-publisher-negative-control')
    if (name === 'wrong-publisher') assert.match(result, /"Status": 0/u, 'Wrong-publisher control must have a valid signature')
    report.cases.push({ name, file, accepted, verificationInvoked, sha512: file === signed ? before.signed : before.unsigned })
    updater.removeAllListeners()
  }
  assert.equal(await digest(signed), before.signed, 'Signed input changed during verification')
  assert.equal(await digest(unsigned), before.unsigned, 'Unsigned input changed during verification')
  report.passed = true
}
finally {
  await writeFile(join(root, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  console.log(`WINDOWS_UPDATE_SIGNATURE_RESULT ${join(root, 'result.json')}`)
}
