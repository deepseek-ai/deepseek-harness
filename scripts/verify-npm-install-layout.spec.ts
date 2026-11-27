import { describe, expect, it } from 'vitest'
import { resolveNpmPackageLock, type NpmPackageLock, type RegistryIndex } from './benchmark-npm-resolution.ts'
import {
  assertDualDshInstallLayout,
  assertRequiredPeerDeclared,
  assertResolutionWorkBudget,
  assertSingleExternalInstallation,
  buildDualDshRegistry,
  MAX_RESOLUTION_WORK_UNITS,
  withNewerExternalRelease,
} from './verify-npm-install-layout.ts'

function validLayout(): NpmPackageLock {
  return {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@deepseek-ai/dsh': '0.2.0', 'dsh-previous': 'npm:@deepseek-ai/dsh@0.1.0' } },
      'node_modules/@deepseek-ai/cordis': { version: '4.0.1' },
      'node_modules/@deepseek-ai/dsh': {
        version: '0.2.0',
        dependencies: { '@deepseek-ai/dsh-child': '^0.2.0' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      },
      'node_modules/@deepseek-ai/dsh-child': {
        version: '0.2.0',
        dependencies: { '@deepseek-ai/dsh-leaf': '^0.2.0' },
      },
      'node_modules/@deepseek-ai/dsh-leaf': { version: '0.2.0' },
      'node_modules/dsh-previous': {
        name: '@deepseek-ai/dsh',
        version: '0.1.0',
        dependencies: { '@deepseek-ai/dsh-child': '^0.1.0' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      },
      'node_modules/dsh-previous/node_modules/@deepseek-ai/dsh-child': {
        version: '0.1.0',
        dependencies: { '@deepseek-ai/dsh-leaf': '^0.1.0' },
      },
      'node_modules/dsh-previous/node_modules/@deepseek-ai/dsh-leaf': { version: '0.1.0' },
    },
  }
}

describe('npm install layout verifier', () => {
  it('creates two incompatible versions of every DSH package', () => {
    const index: RegistryIndex = new Map([
      ['@deepseek-ai/dsh', new Map([['0.1.1-rc.2', {
        name: '@deepseek-ai/dsh',
        version: '0.1.1-rc.2',
        dependencies: { '@deepseek-ai/dsh-child': '^0.1.1-rc.2' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      }]])],
      ['@deepseek-ai/dsh-child', new Map([['0.1.1-rc.2', {
        name: '@deepseek-ai/dsh-child',
        version: '0.1.1-rc.2',
      }]])],
      ['@deepseek-ai/cordis', new Map([['4.0.1', {
        name: '@deepseek-ai/cordis',
        version: '4.0.1',
      }]])],
    ])

    const dual = buildDualDshRegistry(index, '0.1.1-rc.2')

    expect([...dual.get('@deepseek-ai/dsh')?.keys() ?? []]).toEqual(['0.1.0', '0.2.0'])
    expect(dual.get('@deepseek-ai/dsh')?.get('0.1.0')).toMatchObject({
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': '^0.1.0' },
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
    })
    expect(dual.get('@deepseek-ai/dsh')?.get('0.2.0')).toMatchObject({
      version: '0.2.0',
      dependencies: { '@deepseek-ai/dsh-child': '^0.2.0' },
    })
    expect(dual.get('@deepseek-ai/cordis')).toBe(index.get('@deepseek-ai/cordis'))
  })

  it('accepts isolated DSH releases with one shared Cordis installation', () => {
    expect(assertDualDshInstallLayout(validLayout())).toEqual({
      dshPackagesPerVersion: 3,
      checkedDshEdges: 4,
    })
  })

  it.each([
    ['react', 'node_modules/react'],
    ['react-dom', 'node_modules/react-dom'],
    ['react', 'node_modules/dsh-previous/node_modules/react'],
    ['react-dom', 'node_modules/dsh-previous/node_modules/react-dom'],
  ])('rejects browser runtime %s installed at %s in the DSH-only consumer', (name, path) => {
    const layout = validLayout()
    const packages = { ...layout.packages, [path]: { version: '18.3.1' } }
    expect(() => assertDualDshInstallLayout({ ...layout, packages })).toThrow(
      `${path}: ${name} is a browser build input`,
    )
  })

  it('rejects an internal edge that crosses release versions', () => {
    const layout = validLayout()
    const packages = { ...layout.packages }
    Reflect.deleteProperty(packages, 'node_modules/dsh-previous/node_modules/@deepseek-ai/dsh-leaf')

    expect(() => assertDualDshInstallLayout({ ...layout, packages })).toThrow(
      'node_modules/dsh-previous/node_modules/@deepseek-ai/dsh-child: dependencies '
      + '@deepseek-ai/dsh-leaf resolves to node_modules/@deepseek-ai/dsh-leaf@0.2.0, expected 0.1.0',
    )
  })

  it('rejects a second Cordis installation', () => {
    const layout = validLayout()
    const packages = {
      ...layout.packages,
      'node_modules/dsh-previous/node_modules/@deepseek-ai/cordis': { version: '4.0.1' },
    }

    expect(() => assertDualDshInstallLayout({ ...layout, packages })).toThrow(
      'expected one shared @deepseek-ai/cordis',
    )
  })
})

/**
 * One DSH release in which `dsh-first` depends on a package that requires zod as a peer and `dsh-second`
 * pins zod. npm processes `dsh-first` before `dsh-second`.
 */
function sharedZodRegistry(firstDeclaresZod: boolean): RegistryIndex {
  const manifest = (name: string, fields: object = {}) =>
    [name, new Map([['1.0.0', { name, version: '1.0.0', ...fields }]])] as const
  return new Map([
    manifest('@deepseek-ai/dsh', {
      dependencies: { '@deepseek-ai/dsh-first': '1.0.0', '@deepseek-ai/dsh-second': '1.0.0' },
    }),
    manifest('@deepseek-ai/dsh-first', {
      dependencies: { 'zod-peer-host': '1.0.0', ...(firstDeclaresZod ? { zod: '4.6.6' } : {}) },
    }),
    manifest('@deepseek-ai/dsh-second', { dependencies: { zod: '4.6.6' } }),
    manifest('zod-peer-host', { peerDependencies: { zod: '^4.0.0' } }),
    ['zod', new Map([['4.6.6', { name: 'zod', version: '4.6.6' }]])],
  ])
}

describe('shared external package installation', () => {
  it('adds one release a minor above the newest indexed version', () => {
    const index: RegistryIndex = new Map([
      ['zod', new Map([
        ['4.6.6', { name: 'zod', version: '4.6.6', engines: { node: '>=20' } }],
        ['4.4.3', { name: 'zod', version: '4.4.3' }],
      ])],
      ['other', new Map([['1.0.0', { name: 'other', version: '1.0.0' }]])],
    ])

    const newer = withNewerExternalRelease(index, 'zod')

    expect([...newer.get('zod')?.keys() ?? []]).toEqual(['4.6.6', '4.4.3', '4.7.0'])
    expect(newer.get('zod')?.get('4.7.0')).toEqual({ name: 'zod', version: '4.7.0', engines: { node: '>=20' } })
    expect(newer.get('other')).toBe(index.get('other'))
    expect([...index.get('zod')?.keys() ?? []]).toEqual(['4.6.6', '4.4.3'])
  })

  it('rejects an index without the external package', () => {
    expect(() => withNewerExternalRelease(new Map(), 'zod')).toThrow('registry contains no release of zod')
  })

  it('rejects a DSH package that leaves a required peer of its dependency undeclared', () => {
    expect(() => { assertRequiredPeerDeclared(sharedZodRegistry(false), 'zod') }).toThrow(
      'DSH package(s) depend on a package that requires zod as a peer without declaring zod:\n'
      + '  - @deepseek-ai/dsh-first: zod-peer-host@1.0.0 requires zod@^4.0.0\n',
    )
  })

  it('accepts a declared peer, an optional peer, and a dependency range no indexed version satisfies', () => {
    expect(() => { assertRequiredPeerDeclared(sharedZodRegistry(true), 'zod') }).not.toThrow()

    const index = new Map(sharedZodRegistry(false))
    index.set('zod-peer-host', new Map([['1.0.0', {
      name: 'zod-peer-host',
      version: '1.0.0',
      peerDependencies: { zod: '^4.0.0' },
      peerDependenciesMeta: { zod: { optional: true } },
    }]]))
    expect(() => { assertRequiredPeerDeclared(index, 'zod') }).not.toThrow()

    index.set('zod-peer-host', new Map([['2.0.0', {
      name: 'zod-peer-host',
      version: '2.0.0',
      peerDependencies: { zod: '^4.0.0' },
    }]]))
    expect(() => { assertRequiredPeerDeclared(index, 'zod') }).not.toThrow()
  })

  it('accepts one top-level installation', () => {
    expect(() => {
      assertSingleExternalInstallation({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { '@deepseek-ai/dsh': '1.0.0' } },
          'node_modules/@deepseek-ai/dsh': { version: '1.0.0', dependencies: { zod: '4.6.6' } },
          'node_modules/zod': { version: '4.6.6' },
        },
      }, 'zod')
    }).not.toThrow()
  })

  it('rejects private copies and names the hoisted release and their paths', () => {
    expect(() => {
      assertSingleExternalInstallation({
        lockfileVersion: 3,
        packages: {
          'node_modules/@deepseek-ai/dsh-a': { version: '1.0.0' },
          'node_modules/@deepseek-ai/dsh-a/node_modules/zod': { version: '4.6.6' },
          'node_modules/@deepseek-ai/dsh-b/node_modules/zod': { version: '4.6.6' },
          'node_modules/zod': { version: '4.7.0' },
        },
      }, 'zod')
    }).toThrow(
      'expected one zod installation at node_modules/zod, got 3: node_modules/zod@4.7.0 and 2 other(s) such as '
      + 'node_modules/@deepseek-ai/dsh-a/node_modules/zod, node_modules/@deepseek-ai/dsh-b/node_modules/zod',
    )
  })

  it('rejects a layout whose only installation is a private copy', () => {
    expect(() => {
      assertSingleExternalInstallation({
        lockfileVersion: 3,
        packages: { 'node_modules/@deepseek-ai/dsh-a/node_modules/zod': { version: '4.6.6' } },
      }, 'zod')
    }).toThrow('got 1: no node_modules/zod and 1 other(s)')
  })

  it('rejects the layout npm computes when a peer places the newer release first', async () => {
    const result = await resolveNpmPackageLock(
      withNewerExternalRelease(sharedZodRegistry(false), 'zod'),
      { '@deepseek-ai/dsh': '1.0.0' },
      10_000,
    )

    expect(result.packageLock.packages['node_modules/zod']?.version).toBe('4.7.0')
    expect(() => { assertSingleExternalInstallation(result.packageLock, 'zod') }).toThrow(
      'node_modules/zod@4.7.0 and 1 other(s) such as node_modules/@deepseek-ai/dsh-second/node_modules/zod',
    )
  })

  it('accepts the layout npm computes once the package with the peer pins the same version', async () => {
    const result = await resolveNpmPackageLock(
      withNewerExternalRelease(sharedZodRegistry(true), 'zod'),
      { '@deepseek-ai/dsh': '1.0.0' },
      10_000,
    )

    expect(result.packageLock.packages['node_modules/zod']?.version).toBe('4.6.6')
    expect(() => { assertSingleExternalInstallation(result.packageLock, 'zod') }).not.toThrow()
  })
})

describe('resolution work budget', () => {
  it.each([
    [277, 2524, 699_148],
    [316, 2780, 878_480],
    [316, 2786, 880_376],
    [317, 2786, 883_162],
    [320, 2836, 907_520],
    [340, 3320, 1_128_800],
    [341, 3332, 1_136_212],
  ])('accepts the measured dual-release graph with %i packages and %i edges', (packages, edges, units) => {
    expect(assertResolutionWorkBudget({ dshPackagesPerVersion: packages, checkedDshEdges: edges }))
      .toBe(units)
  })

  it('accepts the measured Office install graph', () => {
    expect(assertResolutionWorkBudget({ dshPackagesPerVersion: 317, checkedDshEdges: 2800 }))
      .toBe(887_600)
  })

  it('accepts a graph exactly at the budget and rejects one internal edge above it', () => {
    const packages = 341
    const edgesAtBudget = Math.floor(MAX_RESOLUTION_WORK_UNITS / packages)

    expect(packages * edgesAtBudget).toBe(MAX_RESOLUTION_WORK_UNITS)
    expect(assertResolutionWorkBudget({ dshPackagesPerVersion: packages, checkedDshEdges: edgesAtBudget }))
      .toBe(MAX_RESOLUTION_WORK_UNITS)
    expect(() => assertResolutionWorkBudget({
      dshPackagesPerVersion: packages,
      checkedDshEdges: edgesAtBudget + 1,
    })).toThrow(`= ${String(MAX_RESOLUTION_WORK_UNITS + packages)} unit(s), budget ${String(MAX_RESOLUTION_WORK_UNITS)} unit(s)`)
  })

  it('accepts the headroom and rejects a runaway graph with its own measured counts', () => {
    expect(assertResolutionWorkBudget({ dshPackagesPerVersion: 380, checkedDshEdges: 3700 }))
      .toBe(1_406_000)
    expect(() => assertResolutionWorkBudget({ dshPackagesPerVersion: 420, checkedDshEdges: 3500 }))
      .toThrow(`420 package(s) per release x 3500 internal edge(s) = 1470000 unit(s), budget ${String(MAX_RESOLUTION_WORK_UNITS)} unit(s)`)
  })
})
