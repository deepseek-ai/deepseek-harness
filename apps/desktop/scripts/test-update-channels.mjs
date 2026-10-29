/** Qualify built channel transitions with Electron and the pinned updater, without installing. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { recordVerifiedVersions } from '../tests/updates/electron-updater/versions.mjs'

if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Qualification requires Windows or macOS')
if (process.argv.slice(2).some(arg => arg !== '--record')) throw new Error('Usage: test-update-channels.mjs [--record]')

const root = await mkdtemp(join(tmpdir(), 'desktop-channel-'))
const environment = { ...process.env, DSH_CHANNEL_TEST_ROOT: root }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [fileURLToPath(new URL('../tests/updates/electron-updater/qualification.mjs', import.meta.url))], {
  env: environment, stdio: 'inherit', windowsHide: true,
})
let timedOut = false
const deadline = setTimeout(() => { timedOut = true; child.kill() }, 30_000)
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => signal ? reject(new Error(`Channel qualification ended: timedOut=${timedOut}, signal=${signal}`)) : resolve(code))
  })
  if (timedOut) throw new Error('Channel qualification timed out after 30000 ms')
  if (code !== 0) throw new Error(`Channel qualification failed: ${code}`)
  if (process.argv.includes('--record')) await recordVerifiedVersions()
} finally { clearTimeout(deadline); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
