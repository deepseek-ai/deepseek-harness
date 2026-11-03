/** Check every supported platform without starting Electron or making network requests. */
import { installedVersions, readVerifiedVersions, versionFailures } from './versions.mjs'

const installed = installedVersions()
const failures = versionFailures(await readVerifiedVersions(), installed)
if (failures.length) {
  throw new Error(`Unverified Electron updater dependencies for: ${failures.join(', ')}. Installed: ${JSON.stringify(installed)}. On each listed platform run pnpm --filter @deepseek-ai/dsh-desktop run test:updates:channels --record, then commit verified-versions.json.`)
}
console.log('PASS: Electron updater dependency versions match all platform records')
