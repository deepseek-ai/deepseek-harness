/** ClientRoster: construction, duplicate refusal, order-preserving pick/closure/without with loud unknown names; graphFromRoster. */
import { createClientModuleSystem, parseBootManifest, type ClientBundleRegistration, type ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it } from 'vitest'
import { ClientRoster, graphFromRoster, type ClientRosterRow } from '../src/assembly/roster.ts'
import { MODULES_PACKAGE } from '../src/assembly/modules.ts'

const ROWS: readonly ClientRosterRow[] = [
  { name: MODULES_PACKAGE, inject: [], immediately: true },
  { name: '@x/a', inject: [], immediately: false },
  { name: '@x/b', inject: ['@x/a'], immediately: true },
]

describe('graphFromRoster', () => {
  it('synthesizes one application batch over every row with placeholder URLs', () => {
    expect(graphFromRoster(ROWS)).toEqual({
      rev: 'local',
      entries: [
        { id: MODULES_PACKAGE, url: `/plugins/${MODULES_PACKAGE}/client.js`, rev: 'local', immediately: true },
        { id: '@x/a', url: '/plugins/@x/a/client.js', rev: 'local' },
        { id: '@x/b', url: '/plugins/@x/b/client.js', rev: 'local', inject: ['@x/a'], immediately: true },
      ],
      batches: [{ phase: 'application', url: '/plugins/local.js', rev: 'local', entries: [MODULES_PACKAGE, '@x/a', '@x/b'] }],
    })
  })

  it('parses through the production validator to plugin rows that mirror the roster, refusing duplicates and an empty roster', () => {
    const manifest = parseBootManifest(graphFromRoster(ROWS))
    expect(manifest.plugins).toEqual(ROWS.map(row => ({ id: row.name, inject: [...row.inject], immediately: row.immediately })))
    expect(manifest.modules.map(row => row.initialUrl)).toEqual(['/plugins/local.js', '/plugins/local.js', '/plugins/local.js'])
    const row = ROWS[1]!
    expect(() => parseBootManifest(graphFromRoster([row, row]))).toThrow('duplicate graph entry "@x/a"')
    expect(() => parseBootManifest(graphFromRoster([]))).toThrow('must be a non-empty string array')
  })

  it('imports seeded rows without reaching the bundle transport', async () => {
    const loaded: string[] = []
    const pendingQueue: ClientBundleRegistration[] = []
    const target: ClientModuleLoaderTarget = {
      mode: 'queue',
      pendingQueue,
      load: (registration) => { pendingQueue.push(registration) },
      create: options => createClientModuleSystem(target, { id: MODULES_PACKAGE, exports: {} }, options),
    }
    const a = { apply() {} }
    const b = { apply() {} }
    const modules = target.create({
      boot: graphFromRoster(ROWS),
      staticModules: { '@x/a': a, '@x/b': b },
      loadBundle: async (url) => { loaded.push(url) },
    })
    await expect(modules.import('@x/a')).resolves.toBe(a)
    await expect(modules.import('@x/b')).resolves.toBe(b)
    expect(modules.manifest).toEqual(parseBootManifest(graphFromRoster(ROWS)))
    expect(loaded).toEqual([])
  })
})

const A = { name: 'a', inject: [], immediately: true }
const B = { name: 'b', inject: ['a'], immediately: false }
const C = { name: 'c', inject: ['b'], immediately: false }

describe('ClientRoster', () => {
  it('freezes a copy of the rows in composition order', () => {
    const rows = [A, B, C]
    const roster = ClientRoster.of(rows)
    expect(roster.rows).toEqual([A, B, C])
    expect(roster.rows).not.toBe(rows)
    expect(Object.isFrozen(roster.rows)).toBe(true)
    rows.push(A)
    expect(roster.rows).toHaveLength(3)
  })

  it('refuses duplicate names, listing each duplicate once', () => {
    expect(() => ClientRoster.of([A, B, A, C, B, A])).toThrow('duplicate roster rows: a, b')
  })

  it('pick keeps roster order regardless of the requested order', () => {
    const roster = ClientRoster.of([A, B, C])
    expect(roster.pick(['c', 'a']).rows.map(row => row.name)).toEqual(['a', 'c'])
    expect(roster.pick([]).rows).toEqual([])
    expect(Object.isFrozen(roster.pick(['b']).rows)).toBe(true)
  })

  it('without drops the named rows', () => {
    const roster = ClientRoster.of([A, B, C])
    expect(roster.without(['b']).rows.map(row => row.name)).toEqual(['a', 'c'])
    expect(roster.without(['a', 'b', 'c']).rows).toEqual([])
  })

  it('closure keeps the named rows and everything they inject, transitively, in roster order', () => {
    const D = { name: 'd', inject: [], immediately: false }
    const roster = ClientRoster.of([A, D, B, C])
    expect(roster.closure(['c']).rows.map(row => row.name)).toEqual(['a', 'b', 'c'])
    expect(roster.closure(['b', 'd']).rows.map(row => row.name)).toEqual(['a', 'd', 'b'])
    expect(roster.closure(['a']).rows.map(row => row.name)).toEqual(['a'])
    expect(roster.closure([]).rows).toEqual([])
    expect(Object.isFrozen(roster.closure(['c']).rows)).toBe(true)
  })

  it('pick, closure, and without throw on unknown names with the roster listed; closure also refuses an inject outside the roster', () => {
    const roster = ClientRoster.of([A, B])
    expect(() => roster.pick(['a', 'zz'])).toThrow('pick() names outside the roster: zz; roster: a, b')
    expect(() => roster.closure(['zz'])).toThrow('closure() names outside the roster: zz; roster: a, b')
    expect(() => roster.without(['x', 'y'])).toThrow('without() names outside the roster: x, y; roster: a, b')
    expect(() => ClientRoster.of([B]).closure(['b'])).toThrow('b injects a, which is outside the roster')
  })

  it('closure treats the platform seed modules as satisfied without a row', () => {
    const seeded = { name: 'seeded', inject: ['@deepseek-ai/dsh-client-ui-primitives', 'react', 'a'], immediately: false }
    expect(ClientRoster.of([A, seeded]).closure(['seeded']).rows.map(row => row.name)).toEqual(['a', 'seeded'])
  })
})
