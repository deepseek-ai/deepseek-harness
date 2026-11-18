/** Reading `pnpm view` answers about published versions. */
import { expect, it } from 'vitest'
import { newerVersions, versionFacts } from '../src/versions.ts'

it('reads one version\'s manifest, keeping the asked identity when the answer omits it', () => {
  const bundle = { bundle: { patch: './p.yml' } }
  expect(versionFacts({ name: 'x', version: '1.0.0', engines: { dsh: '>=1' }, peerDependencies: { a: '1' }, deprecated: 'old', dsh: bundle }, 'y', '2.0.0')).toEqual({
    manifest: { name: 'x', version: '1.0.0', engines: { dsh: '>=1' }, peerDependencies: { a: '1' } }, bundle: true, deprecated: 'old',
  })
  expect(versionFacts({ dsh: { bundle: 'no' }, deprecated: '' }, 'y', '2.0.0')).toEqual({ manifest: { name: 'y', version: '2.0.0' }, bundle: false })
  expect(versionFacts('scalar', 'y', '2.0.0')).toEqual({ manifest: { name: 'y', version: '2.0.0' }, bundle: false })
})

it('orders newer semver versions newest first and ignores time and tags that are not objects', () => {
  expect(newerVersions({ versions: ['1.0.0', '1.10.0', '1.2.0', 7], time: 'x', 'dist-tags': [] }, '1.0.0')).toEqual([
    { version: '1.10.0', tags: [], prerelease: false },
    { version: '1.2.0', tags: [], prerelease: false },
  ])
  expect(() => newerVersions(null, '1.0.0')).toThrow('pnpm view answered no versions')
})
