/** Run the built Desktop coordinator against real Electron downloads without installing software. */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

if (process.platform !== 'win32') throw new Error('Local NSIS updater qualification requires Windows')
const root = await mkdtemp(join(tmpdir(), 'dsh-local-updater-'))
let timedOut = false
try {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(name)))
  const child = spawn(electron, [fileURLToPath(new URL('../tests/fixtures/local-updater.mjs', import.meta.url))], {
    env: { ...environment, DSH_LOCAL_UPDATE_TEST_ROOT: root }, stdio: 'inherit', windowsHide: true,
  })
  const timeout = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    if (timedOut) throw new Error('Local updater qualification exceeded its 120-second deadline')
    if (result.signal !== null) throw new Error(`Electron exited on ${result.signal}`)
    if (result.code !== 0) throw new Error(`Local updater qualification failed: exit=${result.code}`)
    const evidenceRoot = fileURLToPath(new URL('../.desktop-build/qualification/', import.meta.url))
    await mkdir(evidenceRoot, { recursive: true })
    const evidence = await mkdtemp(join(evidenceRoot, 'local-updater-'))
    const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
    await copyFile(join(root, 'result.json'), join(evidence, 'result.json'))
    if (report.screenshot.captured) await copyFile(join(root, 'mandatory-update.png'), join(evidence, 'mandatory-update.png'))
    for (const name of report.dialogScreenshots) await copyFile(join(root, name), join(evidence, name))
    console.log(`Local updater evidence: ${evidence}`)
  } finally { clearTimeout(timeout) }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
