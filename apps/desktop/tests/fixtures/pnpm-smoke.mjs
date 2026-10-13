/** Install and use a local dependency with the packaged pnpm and Electron Node launcher. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Exercise offline installation and package scripts without a system pnpm or Node installation.
 * @param {string} resourcesRuntime - Packaged runtime directory outside ASAR.
 * @returns {Promise<void>} Resolves after execution and removal of the private installation.
 */
export async function checkPnpm(resourcesRuntime) {
  assert.ok(process.versions.electron, 'Run the package-manager smoke with Electron Node mode')
  assert.equal(existsSync(join(resourcesRuntime, 'pnpm')), false, 'Desktop must ship only primary-runtime pnpm')
  const primary = join(resourcesRuntime, 'primary-runtime')
  const pnpm = join(primary, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  const versions = JSON.parse(readFileSync(join(resourcesRuntime, 'versions.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(primary, 'runtime.json'), 'utf8'))
  assert.equal(versions.pnpm, manifest.pnpm)
  const scratch = mkdtempSync(join(tmpdir(), 'desktop-pnpm-smoke-'))
  try {
    mkdirSync(join(scratch, 'dependency'))
    writeFileSync(join(scratch, 'dependency', 'package.json'), JSON.stringify({
      name: 'desktop-pnpm-smoke-dependency', version: '1.0.0', main: 'index.cjs',
    }))
    writeFileSync(join(scratch, 'dependency', 'index.cjs'), 'exports.answer = 42\n')
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({
      name: 'desktop-node-script-smoke', private: true,
      dependencies: { 'desktop-pnpm-smoke-dependency': 'file:./dependency' }, scripts: { check: 'node check.cjs' },
    }))
    writeFileSync(join(scratch, 'npmrc'), '')
    writeFileSync(join(scratch, 'check.cjs'), `
const assert = require('node:assert/strict')
assert.equal(require('desktop-pnpm-smoke-dependency').answer, 42)
assert.equal(process.execPath, ${JSON.stringify(process.execPath)})
assert.ok(process.versions.electron)
assert.ok(process.execArgv.includes('--expose-internals'))
assert.equal(typeof require('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
console.log('desktop-node-script-ok')
`)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:systemroot|windir|comspec|LD_LIBRARY_PATH)$/iu.test(name)))
    const systemBin = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'
    const run = args => execFileSync(process.execPath, ['--expose-internals', pnpm, ...args], {
      cwd: scratch, encoding: 'utf8', timeout: 45_000, windowsHide: true,
      env: { ...environment, pnpm_config_verify_deps_before_run: 'false',
        ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(resourcesRuntime, 'bin')}${delimiter}${systemBin}`,
        HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch,
        XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, XDG_STATE_HOME: scratch,
        npm_config_userconfig: join(scratch, 'npmrc'), npm_config_globalconfig: join(scratch, 'npmrc'),
        npm_config_store_dir: join(scratch, 'store'), npm_config_enable_global_virtual_store: 'false',
        npm_config_update_notifier: 'false' },
    })
    assert.equal(run(['--version']).trim(), versions.pnpm)
    run(['install', '--offline', '--ignore-scripts'])
    assert.match(run(['run', 'check']), /desktop-node-script-ok/u)
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

if (import.meta.main) {
  assert.ok(process.argv[2], 'Pass the packaged runtime directory')
  await checkPnpm(process.argv[2])
  console.log('desktop pnpm: offline installation and Electron Node package script passed')
}
