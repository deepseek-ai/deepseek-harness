/** Synchronize competing source-process profile initialization for the race acceptance test. */

import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { initializeProfileFromDefault } from '../../src/profile-boot.ts'

const [home, name, source, ready, gate] = process.argv.slice(2)
if (home === undefined || name === undefined || source === undefined || ready === undefined || gate === undefined) {
  throw new Error('profile initialization fixture requires home, name, source, ready, and gate')
}

writeFileSync(ready, '')
const deadline = Date.now() + 30_000
while (!existsSync(gate)) {
  if (Date.now() >= deadline) throw new Error(`profile initialization fixture timed out waiting for ${gate}`)
  await delay(20)
}
initializeProfileFromDefault(name, source, home)
