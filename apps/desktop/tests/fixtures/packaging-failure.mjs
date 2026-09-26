/** Keep an owned descendant alive until the packaging supervisor handles a simulated fatal error. */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { failPackagingRun } from '../../scripts/packaging-run.mjs'

const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
})
child.once('message', () => {
  writeFileSync(join(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'descendant.json'), JSON.stringify({ pid: child.pid }))
  failPackagingRun(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'simulated-signing-failure')
})
setInterval(() => {}, 1000)
