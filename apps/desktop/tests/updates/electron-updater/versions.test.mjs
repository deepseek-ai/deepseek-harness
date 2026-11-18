/** Negative controls for the platform version gate. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { versionFailures, installedVersions } from './versions.mjs'

test('accepts only matching complete records for both platforms', () => {
  const installed = installedVersions()
  assert.deepEqual(versionFailures({ windows: installed, macos: installed }, installed), [])
  assert.deepEqual(versionFailures({ windows: installed, macos: null }, installed), ['macos'])
  assert.deepEqual(versionFailures({}, installed), ['windows', 'macos'])
  for (const name of Object.keys(installed)) {
    assert.deepEqual(versionFailures({ windows: { ...installed, [name]: '0.0.0' }, macos: installed }, installed), ['windows'])
    const missing = { ...installed }
    delete missing[name]
    assert.deepEqual(versionFailures({ windows: installed, macos: missing }, installed), ['macos'])
  }
  assert.deepEqual(versionFailures({ windows: { ...installed, obsolete: '1' }, macos: installed }, installed), ['windows'])
})
