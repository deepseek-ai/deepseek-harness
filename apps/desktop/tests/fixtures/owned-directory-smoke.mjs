/** Built Desktop cleanup smoke; run with Electron and ELECTRON_RUN_AS_NODE=1. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeOwnedDirectory } from '../../lib/types/owned-directory.js'
import { inventoryDesktopRuntime } from '../../lib/types/runtime-tree.js'

assert.ok(process.versions.electron, 'This regression must run under Electron')
const root = mkdtempSync(join(tmpdir(), 'desktop-electron-cleanup-'))
try {
  const resources = join(root, 'resources')
  mkdirSync(resources)
  writeFileSync(join(resources, 'sentinel'), 'installed runtime bytes')
  const inventory = inventoryDesktopRuntime(resources)
  const profile = join(root, 'rollback-profile')
  const packages = join(profile, 'node_modules', '@unknown')
  mkdirSync(packages, { recursive: true })
  symlinkSync(resources, join(packages, 'host-package'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(packages, 'private-file'), 'removed')
  removeOwnedDirectory(profile)
  assert.equal(existsSync(profile), false)
  assert.deepEqual(inventoryDesktopRuntime(resources), inventory)
  assert.equal(readFileSync(join(resources, 'sentinel'), 'utf8'), 'installed runtime bytes')
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.version, preservedLinkTarget: true }))
} finally {
  removeOwnedDirectory(root)
}
