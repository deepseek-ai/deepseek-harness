/** Isolate root-scope traversal; the filesystem root is read but never modified. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PackageManifests } from '../../src/package-manifest.ts'

const [root] = process.argv.slice(2)
const reader = createRequire(import.meta.url)('internal/modules/package_json_reader')
const source = join(root, 'missing', 'entry.js')
const url = pathToFileURL(source).href
const expectedScope = reader.getPackageScopeConfig(url)
const expectedNearest = reader.getNearestParentPackageJSON(source)
const manifests = new PackageManifests()
try {
  await manifests.invalidate(join(parse(root).root, 'package.json'))
  assert.deepEqual(reader.getPackageScopeConfig(url), expectedScope)
  assert.deepEqual(reader.getNearestParentPackageJSON(source), expectedNearest)
  process.stdout.write('scope traversal completed\n')
} finally {
  manifests.dispose()
}
