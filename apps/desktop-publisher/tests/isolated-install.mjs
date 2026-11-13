/** Run only in a clean checkout after installing this workspace's production dependencies. */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import '../src/resolve-desktop-publish-ci.ts'
import { prepareDesktopRolloutCi } from '../src/publish-desktop-rollout-ci.ts'
import { desktopReleasesRoot } from '../src/desktop-releases-root.ts'
import { teo } from 'tencentcloud-sdk-nodejs-teo'

const require = createRequire(import.meta.url)
for (const dependency of ['electron', 'electron-builder', 'app-builder-lib', 'react', 'vite', 'typescript']) {
  assert.throws(() => require.resolve(dependency), { code: 'MODULE_NOT_FOUND' }, `${dependency} must not be installed`)
}
assert.equal(existsSync(new URL('../../desktop/node_modules', import.meta.url)), false)
assert.equal(typeof teo.v20220901.Client, 'function')
assert.throws(() => desktopReleasesRoot({}), /DSH_PACKAGING_CONFIG_DIR is required/)
await assert.rejects(prepareDesktopRolloutCi({}), /runId/)
console.log('Desktop publisher isolated install: OK (no package build, credentials or remote operations)')
