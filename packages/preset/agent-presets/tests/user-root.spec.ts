/**
 * The writable root is this package's own, not an assembly fact each app must
 * remember: a roster configured with only a `system` root still discovers and
 * authors into `<dshHome>/.agent-presets`, the way `dsh-skill-filesystem` owns
 * `<dshHome>/skills`. `includeUserRoot: false` is how a deployment — or a test
 * pinning an exact roster — opts out.
 *
 * `$DSH_HOME` is repointed per test because the derived root is resolved in the
 * constructor: the plugin must be mounted while the environment names the
 * temporary home, or it would reach the developer's real one.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AgentPresets, { COMPOSITION_FILE, type Config } from '@deepseek-ai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const SYSTEM_ROOT = join(FIXTURES, 'system')
/** Spelled out rather than imported: the convention is what these tests assert. */
const USER_ROOT_SEGMENT = '.agent-presets'
const VALID = '- id: tool-alpha\n  name: ../../plugins/contribute.js\n  config:\n    tool: alpha\n'

let home: string
let previousHome: string | undefined

/** Extra per-test roots, removed with the home directory. */
const explicitRoots: string[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-preset-home-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
  for (const root of explicitRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Boot a roster over the fixture system root, with the derived root left to the plugin. */
async function roster(config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [{ path: SYSTEM_ROOT, trust: 'system' as const }],
    // The package's shipped presets would shadow this file's fixture ids.
    includeShippedRoot: false,
    includeUserRoot: true,
    ...config,
  })
  return ctx
}

/** Hand-place a preset directory under the harness home's preset root. */
async function seedHomePreset(id: string): Promise<void> {
  await mkdir(join(home, USER_ROOT_SEGMENT, id), { recursive: true })
  await writeFile(join(home, USER_ROOT_SEGMENT, id, COMPOSITION_FILE), VALID)
}

describe('the harness-home preset root', () => {
  it('is what a roster gets when config names no roots at all', () => {
    // The schema default is the contract an app relies on by saying nothing;
    // every other case here passes the field explicitly. The cast stands for
    // the untyped document the Loader hands the schema, which is where a
    // composition that omits the key actually comes from.
    const parsed = AgentPresets.Config({ default: 'standard' } as unknown as Config)

    expect(parsed).toMatchObject({ includeUserRoot: true, roots: [] })
  })

  it('is discovered without any app configuring it', async () => {
    await seedHomePreset('mine')
    const ctx = await roster()

    const listed = await ctx.agentPresets.list()

    expect(listed.find(preset => preset.id === 'mine')).toMatchObject({ trust: 'user' })
    expect((await ctx.agentPresets.resolve('mine')).path)
      .toBe(join(home, USER_ROOT_SEGMENT, 'mine', COMPOSITION_FILE))
  })

  it('makes a roster with only a system root authorable, and receives the copy', async () => {
    const ctx = await roster()

    expect(ctx.agentPresets.authorable).toBe(true)
    await ctx.agentPresets.copy('standard', 'copied')

    expect(existsSync(join(home, USER_ROOT_SEGMENT, 'copied', COMPOSITION_FILE))).toBe(true)
  })

  it('sorts after every configured root, so a shipped id still shadows a home directory', async () => {
    // `standard` exists in the fixture system root; claiming the name at home
    // must not take it over, because `copy` refuses an id any root supplies
    // and a session resolving `standard` must reach the shipped composition.
    await seedHomePreset('standard')
    const ctx = await roster()

    expect((await ctx.agentPresets.resolve('standard')).trust).toBe('system')
    await expect(ctx.agentPresets.copy('standard', 'standard')).rejects.toThrow(/already exists/)
  })

  it('is absent under includeUserRoot: false, which leaves the roster unauthorable', async () => {
    await seedHomePreset('mine')
    const ctx = await roster({ includeUserRoot: false })

    expect((await ctx.agentPresets.list()).map(preset => preset.id)).not.toContain('mine')
    expect(ctx.agentPresets.authorable).toBe(false)
    await expect(ctx.agentPresets.copy('standard', 'mine'))
      .rejects.toThrow(/no user-writable preset root/)
  })

  it('yields to a configured user root for authoring, which writableRoot takes first', async () => {
    const explicit = await mkdtemp(join(tmpdir(), 'dsh-preset-explicit-'))
    explicitRoots.push(explicit)
    const ctx = await roster({
      roots: [
        { path: SYSTEM_ROOT, trust: 'system' as const },
        { path: explicit, trust: 'user' as const },
      ],
    })

    await ctx.agentPresets.copy('standard', 'copied')

    expect(existsSync(join(explicit, 'copied', COMPOSITION_FILE))).toBe(true)
    expect(existsSync(join(home, USER_ROOT_SEGMENT, 'copied'))).toBe(false)
  })
})
