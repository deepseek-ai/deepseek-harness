import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMPOSITION_FILE, discoverPresets, scanRoot } from '@deepseek-ai/dsh-agent-presets'

const fsHarness = vi.hoisted(() => ({
  nextReadError: undefined as NodeJS.ErrnoException | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (path: unknown, ...rest: never[]) => {
      const error = fsHarness.nextReadError
      if (error !== undefined) {
        fsHarness.nextReadError = undefined
        throw error
      }
      return (actual.readFile as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readFile,
  }
})

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
// Standing in for the installed harness: a row's package name resolves from
// here, and this directory's upward `node_modules` walk reaches the workspace.
const HARNESS = new URL('.', import.meta.url).href
const SYSTEM = { path: join(FIXTURES, 'system'), trust: 'system' as const }
const USER = { path: join(FIXTURES, 'user'), trust: 'user' as const }

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

beforeEach(() => {
  fsHarness.nextReadError = undefined
})

describe('display order', () => {
  it('puts declared order first, then everything else by id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-order-'))
    roots.push(root)
    for (const [id, order] of [['zulu', 1], ['alpha', 2]] as const) {
      await mkdir(join(root, id), { recursive: true })
      await writeFile(join(root, id, COMPOSITION_FILE), '[]\n')
      await writeFile(join(root, id, 'preset.yml'), `order: ${String(order)}\n`)
    }
    for (const id of ['bravo', 'yankee']) {
      await mkdir(join(root, id), { recursive: true })
      await writeFile(join(root, id, COMPOSITION_FILE), '[]\n')
    }

    const found = await scanRoot({ path: root, trust: 'system' }, HARNESS)

    // The shipped set reads by capability; presets that declare nothing stay
    // alphabetical behind them rather than interleaving unpredictably.
    expect(found.map(preset => preset.id)).toEqual(['zulu', 'alpha', 'bravo', 'yankee'])
  })

  it('breaks a tie between equal declared orders by id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-order-tie-'))
    roots.push(root)
    for (const id of ['yankee', 'alpha']) {
      await mkdir(join(root, id), { recursive: true })
      await writeFile(join(root, id, COMPOSITION_FILE), '[]\n')
      await writeFile(join(root, id, 'preset.yml'), 'order: 1\n')
    }

    const found = await scanRoot({ path: root, trust: 'system' }, HARNESS)

    // Two presets claiming the same slot must still list in a stable order:
    // a directory-scan order would reshuffle the picker between reads.
    expect(found.map(preset => preset.id)).toEqual(['alpha', 'yankee'])
  })
})

describe('preset discovery', () => {
  it('reports one preset per directory holding a composition, ordered by id', async () => {
    const found = await scanRoot(SYSTEM, HARNESS)

    expect(found.map(preset => preset.id)).toEqual(['minimal', 'standard'])
    expect(found[0]).toEqual({
      id: 'minimal',
      trust: 'system',
      path: join(SYSTEM.path, 'minimal', COMPOSITION_FILE),
    })
  })

  it('reports a directory with no composition as a broken preset slot', async () => {
    const found = await scanRoot(USER, HARNESS)

    // The directory still occupies its id — a copy to that name is refused —
    // so hiding it would leave nothing to see or delete. It surfaces broken.
    const ghost = found.find(preset => preset.id === 'not-a-preset')
    expect(ghost?.broken).toMatch(/agent\.cordis\.yml is missing/)
  })

  it('skips a directory whose name no preset id could ever claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-oddname-'))
    roots.push(root)
    await mkdir(join(root, '.hidden'))
    await mkdir(join(root, 'Has_Caps'))
    await mkdir(join(root, 'usable'))
    await writeFile(join(root, 'usable', COMPOSITION_FILE), '[]\n')

    const found = await scanRoot({ path: root, trust: 'user' }, HARNESS)

    // `.hidden` and `Has_Caps` cannot collide with any copy target, so
    // reporting tool residue as broken presets would only train users to
    // ignore the marker.
    expect(found.map(preset => preset.id)).toEqual(['usable'])
  })

  it('records the root trust on every preset it discovers', async () => {
    const found = await scanRoot(USER, HARNESS)

    expect(found.every(preset => preset.trust === 'user')).toBe(true)
  })

  it('lets the earlier root win a duplicate id', async () => {
    const found = await discoverPresets([SYSTEM, USER], HARNESS)

    const standard = found.filter(preset => preset.id === 'standard')
    expect(standard).toHaveLength(1)
    expect(standard[0]?.trust).toBe('system')
  })

  it('treats an absent root as supplying no presets', async () => {
    const found = await scanRoot({ path: join(FIXTURES, 'no-such-root'), trust: 'user' }, HARNESS)

    expect(found).toEqual([])
  })

  it('ignores a plain file sitting beside the preset directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-'))
    roots.push(root)
    await writeFile(join(root, 'stray.yml'), '- id: x\n')
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', COMPOSITION_FILE), '[]\n')

    const found = await scanRoot({ path: root, trust: 'user' }, HARNESS)

    expect(found.map(preset => preset.id)).toEqual(['real'])
  })

  it('reports a root it cannot read rather than treating it as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-'))
    roots.push(root)
    const notADirectory = join(root, 'file-as-root')
    await writeFile(notADirectory, 'not a directory\n')

    await expect(scanRoot({ path: notADirectory, trust: 'user' }, HARNESS))
      .rejects.toThrow(/cannot read preset root/)
  })

  it('expands a leading tilde in a root path', async () => {
    // `~` alone resolves to the home directory, which exists but holds no
    // preset directories; the point is that it did not throw on a literal `~`.
    const found = await scanRoot({ path: '~/.dsh-agent-presets-absent', trust: 'user' }, HARNESS)

    expect(found).toEqual([])
  })
})

describe('composition health', () => {
  /**
   * One directory under a fresh root holding `composition`, scanned.
   *
   * Rows that exist only to carry a shape name `js-yaml`, a package the
   * harness base really resolves: health resolves every enabled row's module,
   * so an invented name would answer the wrong check.
   * @param composition - the composition file's contents.
   * @returns the reported reason, or undefined when the composition is healthy.
   */
  async function scanned(composition: string): Promise<string | undefined> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-health-'))
    roots.push(root)
    await mkdir(join(root, 'probe'))
    await writeFile(join(root, 'probe', COMPOSITION_FILE), composition)
    const [preset] = await scanRoot({ path: root, trust: 'user' }, HARNESS)
    return preset?.broken
  }

  it('reports unparsable YAML with the parser\'s reason', async () => {
    expect(await scanned('- id: x\n  name: [unclosed\n')).toMatch(/not valid YAML/)
  })

  it('reports a composition that is not a list of rows', async () => {
    expect(await scanned('name: not-a-list\n')).toMatch(/top-level list of plugin rows/)
  })

  it('reports the first row that names no plugin, by position', async () => {
    expect(await scanned('- id: ok\n  name: js-yaml\n- id: broken\n'))
      .toMatch(/row 2 names no plugin/)
  })

  it('reports a row that is not a map at all', async () => {
    expect(await scanned('- just-a-string\n')).toMatch(/row 1 is not a plugin row/)
  })

  it('descends into a group\'s own row list', async () => {
    const composition = '- id: grp\n  name: cordis:group\n  group: true\n  config:\n    - id: inner\n'
    expect(await scanned(composition)).toMatch(/row 1 row 1 names no plugin/)
  })

  it('reports a group whose config is not a list', async () => {
    const composition = '- id: grp\n  name: cordis:group\n  group: true\n  config: not-a-list\n'
    expect(await scanned(composition)).toMatch(/group row 1 must hold a list/)
  })

  it('accepts a group whose own list is healthy', async () => {
    const composition = '- id: grp\n  name: cordis:group\n  group: true\n  config:\n    - id: inner\n      name: js-yaml\n'
    expect(await scanned(composition)).toBeUndefined()
  })

  it('reports a composition that stats but cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-unreadable-'))
    roots.push(root)
    await mkdir(join(root, 'sealed'))
    const path = join(root, 'sealed', COMPOSITION_FILE)
    await writeFile(path, '[]\n')
    fsHarness.nextReadError = Object.assign(new Error('EACCES: injected read failure'), { code: 'EACCES' })

    const [preset] = await scanRoot({ path: root, trust: 'user' }, HARNESS)

    expect(fsHarness.nextReadError).toBeUndefined()
    expect(preset?.broken).toMatch(/cannot be read/)
  })

  it('accepts the loader dialect, !!js scalars included', async () => {
    // Health must never call a composition broken that the loader accepts:
    // `!!js` is the loader's own extension, so it parses here too.
    const composition = '- id: x\n  name: js-yaml\n  config:\n    value: !!js "1 + 1"\n'
    expect(await scanned(composition)).toBeUndefined()
  })

  it('accepts an empty list', async () => {
    expect(await scanned('[]\n')).toBeUndefined()
  })
})

describe('rows naming a plugin that cannot be resolved', () => {
  /** One directory under a fresh root holding `composition`, scanned. */
  async function scanned(composition: string): Promise<string | undefined> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-resolve-'))
    roots.push(root)
    await mkdir(join(root, 'probe'))
    await writeFile(join(root, 'probe', COMPOSITION_FILE), composition)
    const [preset] = await scanRoot({ path: root, trust: 'user' }, HARNESS)
    return preset?.broken
  }

  it('reports a package the harness cannot resolve, with the row and the name', async () => {
    // The way an authored preset actually rots: it named a package that a
    // later release renamed, so the composition still parses and still cannot
    // compose a session.
    expect(await scanned('- id: stale\n  name: \'@deepseek-ai/dsh-no-such-package\'\n'))
      .toBe('row "stale" names a plugin that cannot be resolved: @deepseek-ai/dsh-no-such-package')
  })

  it('names every unresolvable row rather than only the first', async () => {
    // Unlike a parse failure, one unresolvable name tells you nothing about
    // the next: fixing them one reload at a time is the avoidable part.
    const composition = '- id: a\n  name: no-such-a\n- id: b\n  name: no-such-b\n'

    expect(await scanned(composition)).toBe(
      '2 rows name plugins that cannot be resolved:\n- row "a": no-such-a\n- row "b": no-such-b')
  })

  it('falls back to the row position when a row declares no id', async () => {
    // One `row` prefix, not two: the label carries it either way.
    expect(await scanned('- name: no-such-plugin\n'))
      .toBe('row 1 names a plugin that cannot be resolved: no-such-plugin')
  })

  it('descends into a group and keeps the group in the label', async () => {
    const composition = '- id: grp\n  name: cordis:group\n  group: true\n  config:\n    - name: no-such-plugin\n'

    expect(await scanned(composition)).toMatch(/row 1 row 1 names a plugin that cannot be resolved/)
  })

  it('resolves a preset-relative row against the preset\'s own directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-presets-relative-'))
    roots.push(root)
    await mkdir(join(root, 'probe'))
    await writeFile(join(root, 'probe', 'own-plugin.mjs'), 'export function apply() {}\n')
    await writeFile(join(root, 'probe', COMPOSITION_FILE), '- id: own\n  name: ./own-plugin.mjs\n- id: gone\n  name: ./deleted.mjs\n')

    const [preset] = await scanRoot({ path: root, trust: 'user' }, HARNESS)

    // A file the preset ships resolves beside its composition, not from the
    // harness — the same split the mount's import override makes.
    expect(preset?.broken).toBe('row "gone" names a plugin that cannot be resolved: ./deleted.mjs')
  })

  it('skips a row the loader may never start', async () => {
    // `disabled` is the one entry field the Loader interpolates, so a `!!js`
    // row cannot be judged from the file; calling a usable preset broken is
    // worse than leaving a switched-off row to fail at mount as before.
    const composition = '- id: off\n  name: no-such-plugin\n  disabled: true\n'
      + '- id: maybe\n  name: no-such-either\n  disabled: !!js process.platform === \'win32\'\n'

    expect(await scanned(composition)).toBeUndefined()
  })

  it.each(['false', '0', "''"])('checks a row the loader would start (disabled: %s)', async (value) => {
    // The Loader starts a row when `Boolean(options.disabled)` is false, so a
    // falsy-but-present value names a row that does run.
    expect(await scanned(`- id: on\n  name: no-such-plugin\n  disabled: ${value}\n`))
      .toMatch(/cannot be resolved/)
  })

  it('reports a file: URL whose target is not there', async () => {
    // The Loader accepts a `file:` URL for the same thing an absolute path
    // names; a resolver handed one only normalizes it and never looks.
    const missing = pathToFileURL(join(tmpdir(), 'dsh-presets-absent', 'nope.mjs')).href
    expect(await scanned(`- id: url\n  name: '${missing}'\n`)).toMatch(/cannot be resolved/)
  })

  it('reads an installed package off disk without asking the resolver', async () => {
    // The fast path, and the one that has to answer alone: this package has a
    // directory and nothing to import, so a resolver would reject it.
    const home = await mkdtemp(join(tmpdir(), 'dsh-presets-installed-'))
    roots.push(home)
    await mkdir(join(home, 'node_modules', '@scope', 'pkg'), { recursive: true })
    await writeFile(join(home, 'node_modules', '@scope', 'pkg', 'package.json'), '{"name":"@scope/pkg"}\n')
    await mkdir(join(home, 'presets', 'probe'), { recursive: true })
    await writeFile(join(home, 'presets', 'probe', COMPOSITION_FILE), "- id: p\n  name: '@scope/pkg'\n")

    const [preset] = await scanRoot(
      { path: join(home, 'presets'), trust: 'user' }, pathToFileURL(join(home, 'app/')).href)

    expect(preset?.broken).toBeUndefined()
  })

  it('reports a package whose install link dangles', async () => {
    // What a stale profile install leaves behind: the name is still in
    // `node_modules`, pointing at a checkout that is gone.
    const home = await mkdtemp(join(tmpdir(), 'dsh-presets-dangling-'))
    roots.push(home)
    await mkdir(join(home, 'node_modules', '@scope'), { recursive: true })
    await symlink(join(home, 'deleted-checkout'), join(home, 'node_modules', '@scope', 'pkg'))
    await mkdir(join(home, 'presets', 'probe'), { recursive: true })
    await writeFile(join(home, 'presets', 'probe', COMPOSITION_FILE), "- id: p\n  name: '@scope/pkg'\n")

    const [preset] = await scanRoot(
      { path: join(home, 'presets'), trust: 'user' }, pathToFileURL(join(home, 'app/')).href)

    expect(preset?.broken).toBe('row "p" names a plugin that cannot be resolved: @scope/pkg')
  })

  it('leaves a node builtin alone', async () => {
    // Nothing installs `node:fs`, so the disk walk finds nothing; calling a
    // composition broken over a name Node always supplies would be a false
    // report, which costs more than the row it would have caught.
    expect(await scanned('- id: b\n  name: node:fs\n')).toBeUndefined()
  })

  it('leaves a cordis builtin alone', async () => {
    // A `cordis:` name is supplied by the Loader itself, so there is nothing
    // to resolve — as a row of its own, and as the group it recurses into.
    expect(await scanned('- id: inc\n  name: cordis:include\n  config:\n    path: ./nested.cordis.yml\n'))
      .toBeUndefined()
    expect(await scanned('- id: grp\n  name: cordis:group\n  group: true\n  config: []\n')).toBeUndefined()
  })
})
