/** Qualify built channel transitions with Electron and the pinned updater, without installing. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = await mkdtemp(join(tmpdir(), 'desktop-channel-'))
const environment = { ...process.env, DSH_CHANNEL_TEST_ROOT: root }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [fileURLToPath(new URL('../tests/fixtures/update-channels.mjs', import.meta.url))], {
  env: environment, stdio: 'inherit', windowsHide: true,
})
const deadline = setTimeout(() => { child.kill() }, 30_000)
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => signal ? reject(new Error(`Channel qualification ended on ${signal}`)) : resolve(code))
  })
  if (code !== 0) throw new Error(`Channel qualification failed: ${code}`)
} finally { clearTimeout(deadline); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
