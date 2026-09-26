/** Verify supplied executable files without invoking SignTool, private keys, or installer entry points. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)

/**
 * Hash a file without loading its complete contents into memory.
 * @param {string} path Local file.
 * @returns {Promise<string>} Base64 SHA-512.
 */
export async function installedUpdateFileHash(path) {
  const hash = createHash('sha512')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('base64')
}

/**
 * Require the real updater verifier, a valid Authenticode signature, and a timestamp.
 * @param {string} file Executable inspected as data, never executed.
 * @param {string} publisher Expected DN from the trusted public release certificate, not downloaded YAML.
 * @param {string} directory New private evidence directory owned by this signature check.
 * @returns {Promise<object>} Public signature attributes and unchanged-file SHA-512; no installation claim.
 */
export async function verifyInstalledUpdateSignature(file, publisher, directory) {
  if (process.platform !== 'win32') throw new Error('installed update: signature verification requires Windows')
  const before = await installedUpdateFileHash(file)
  const config = join(directory, 'signature-config.json')
  await writeFile(config, `${JSON.stringify({ publisherName: [publisher] })}\n`, { flag: 'wx', flush: true })
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$|^PSModulePath$/iu.test(name)))
  const options = { env: environment, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 }
  const verification = await promisify(execFile)(process.execPath, [import.meta.filename, '--updater', config, file], options)
  if (JSON.parse(verification.stdout).updaterVerificationInvoked !== true) {
    throw new Error('installed update: updater signature verification was not confirmed')
  }
  const { stdout, stderr } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $s=Get-AuthenticodeSignature -LiteralPath $env:DSH_VERIFY_FILE; [pscustomobject]@{valid=($s.Status -eq "Valid");timestamped=($null -ne $s.TimeStamperCertificate);signer=$s.SignerCertificate.Thumbprint;timestamp=$s.TimeStamperCertificate.Thumbprint}|ConvertTo-Json -Compress'],
  { ...options, env: { ...environment, DSH_VERIFY_FILE: file } })
  const details = JSON.parse(stdout)
  if (stderr || details.valid !== true || details.timestamped !== true || !/^[A-Fa-f0-9]{40}$/u.test(details.signer)
    || !/^[A-Fa-f0-9]{40}$/u.test(details.timestamp)) throw new Error('installed update: valid timestamped signature is required')
  if (await installedUpdateFileHash(file) !== before) throw new Error('installed update: file changed during signature verification')
  return { sha512: before, valid: true, timestamped: true, signerThumbprint: details.signer,
    timestampThumbprint: details.timestamp, updaterVerificationInvoked: true }
}

async function verifyWithUpdater(config, file) {
  const { NsisUpdater } = require('electron-updater')
  const updater = new NsisUpdater(null, { version: '0.0.0', isPackaged: true })
  updater.autoInstallOnAppQuit = false
  updater.updateConfigPath = config
  const logs = []
  updater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, value => logs.push(String(value))]))
  try {
    const result = await updater.verifySignature(file)
    if (result !== null || !logs.some(line => line.startsWith('Verifying signature '))
      || logs.some(line => line.includes('Ignoring signature validation'))) {
      throw new Error('installed update: updater signature verification rejected the file or was skipped')
    }
    return { updaterVerificationInvoked: true }
  } finally { updater.removeAllListeners() }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [mode, config, file, ...extra] = process.argv.slice(2)
  if (mode !== '--updater' || !config || !file || extra.length) process.exitCode = 1
  else verifyWithUpdater(config, file).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('installed update: updater signature verification failed')
    process.exitCode = 1
  })
}
