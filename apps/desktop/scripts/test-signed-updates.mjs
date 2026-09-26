/** Run real Electron downloads from local executable inputs without installing or publishing them. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

assert.equal(process.platform, 'win32', 'Signed NSIS download qualification requires Windows')
const [certificate, signed, unsigned, old] = process.argv.slice(2)
assert.ok(certificate && signed && unsigned,
  'Usage: node apps/desktop/scripts/test-signed-updates.mjs <public.cer> <signed.exe> <unsigned.exe> [old.exe]')
const paths = await Promise.all([certificate, signed, unsigned, ...(old ? [old, `${signed}.blockmap`, `${old}.blockmap`] : [])]
  .map(file => realpath(file)))
const evidence = fileURLToPath(new URL('../.desktop-build/qualification/', import.meta.url))
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(evidence, 'signed-downloads-'))
await mkdir(join(root, 'runtime'))
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name)))
let timedOut = false
const timeoutMs = Number(process.env.DSH_SIGNED_UPDATE_TEST_TIMEOUT_MS ?? 180_000)
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 180_000,
  'DSH_SIGNED_UPDATE_TEST_TIMEOUT_MS must be an integer from 1000 to 180000')
let termination = Promise.resolve()
let terminationError
let launchError
const startedAt = new Date().toISOString()
const child = spawn(electron, [fileURLToPath(new URL('../tests/fixtures/signed-updates.mjs', import.meta.url))], {
  env: { ...environment, DSH_SIGNED_UPDATE_TEST_ROOT: root,
    DSH_SIGNED_UPDATE_CERTIFICATE: paths[0], DSH_SIGNED_UPDATE_SIGNED: paths[1], DSH_SIGNED_UPDATE_UNSIGNED: paths[2],
    DSH_SIGNED_UPDATE_OLD: paths[3] ?? '' },
  stdio: 'inherit', windowsHide: true,
})
child.once('error', error => { launchError = error.message })
const deadline = setTimeout(() => {
  timedOut = true
  // Authenticode starts PowerShell; stop the complete owned process tree before deleting downloads.
  termination = new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      env: environment, stdio: 'ignore', windowsHide: true,
    })
    killer.once('error', error => { terminationError = error.message })
    killer.once('close', (code) => {
      if (code !== 0) terminationError ??= `taskkill exited ${code}`
      resolve()
    })
  })
}, timeoutMs)
try {
  const result = await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(deadline)
  await termination
  await writeFile(join(root, 'process.json'), `${JSON.stringify({ ...result, timedOut, pid: child.pid,
    startedAt, completedAt: new Date().toISOString(), launchError, terminationError }, null, 2)}\n`)
  assert.equal(launchError, undefined)
  assert.equal(terminationError, undefined)
  assert.equal(timedOut, false, `Signed download qualification exceeded ${timeoutMs} ms`)
  assert.equal(result.signal, null, `Electron exited on ${result.signal}`)
  assert.equal(result.code, 0, `Signed download qualification failed; see ${root}`)
  const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
  assert.equal(report.passed, true)
}
finally {
  clearTimeout(deadline)
  await termination
  // Only this invocation's runtime directory is removed after process exit; reports remain.
  await rm(join(root, 'runtime'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log(`SIGNED_UPDATE_DOWNLOAD_RESULT ${root}`)
}
