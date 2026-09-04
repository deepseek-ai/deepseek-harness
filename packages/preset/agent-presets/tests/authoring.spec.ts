/**
 * Authoring a preset copies an existing one's directory into the deployment's
 * `user` root — copy is the only authoring write, so no caller ever supplies
 * composition text. The id is a directory name, so its pattern is a
 * containment boundary rather than a style rule; the shipped `.system` set
 * stays read-only.
 */

import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AgentPresets, {
  COMPOSITION_FILE, copyComposition, METADATA_FILE, type Config,
} from '@deepseek-ai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const VALID = '- id: tool-alpha\n  name: ../../plugins/contribute.js\n  config:\n    tool: alpha\n'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

let ctx: Context
let userRoot: string

/** Mount the required projection seam before the roster service. */
async function mountAgentPresets(context: Context, config: Config): Promise<void> {
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(AgentPresets, config)
}

/** Hand-craft a preset directory (tests cannot author text through the service). */
async function seedPreset(
  root: string, id: string, options: { composition?: string; metadata?: string; extras?: Record<string, string> } = {},
): Promise<void> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, COMPOSITION_FILE), options.composition ?? VALID)
  if (options.metadata !== undefined) {
    await writeFile(join(root, id, METADATA_FILE), options.metadata)
  }
  for (const [name, content] of Object.entries(options.extras ?? {})) {
    await mkdir(dirname(join(root, id, name)), { recursive: true })
    await writeFile(join(root, id, name), content)
  }
}

beforeEach(async () => {
  userRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-authoring-'))
  roots.push(userRoot)
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentPresets(ctx, {
    default: 'standard',
    roots: [
      { path: join(FIXTURES, 'system'), trust: 'system' as const },
      { path: userRoot, trust: 'user' as const },
    ],
    // Every roster in this file pins its own roots: the package's shipped
    // presets would shadow the fixture ids, and the derived harness-home root
    // would add the developer's real presets to what these assertions count —
    // and `copy` would write into it.
    includeShippedRoot: false,
    includeUserRoot: false,
  })
})

describe('copying a preset', () => {
  it('copies a shipped preset into the user root and lists it', async () => {
    await ctx.agentPresets.copy('standard', 'mine')

    expect(await readFile(join(userRoot, 'mine', COMPOSITION_FILE), 'utf8'))
      .toBe(await ctx.agentPresets.read('standard'))
    const listed = await ctx.agentPresets.list()
    expect(listed.find(preset => preset.id === 'mine')?.trust).toBe('user')
  })

  it('copies the whole directory and tightens POSIX modes', async () => {
    await seedPreset(userRoot, 'source', {
      extras: { 'skills/demo/SKILL.md': '# demo\n', 'skills/demo/run.sh': '#!/bin/sh\n' },
    })
    if (process.platform !== 'win32') {
      await chmod(join(userRoot, 'source', 'skills', 'demo', 'run.sh'), 0o755)
    }

    await ctx.agentPresets.copy('source', 'mine')

    expect(await readFile(join(userRoot, 'mine', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# demo\n')
    // Windows mode bits are synthetic and cannot represent the inherited DACL.
    if (process.platform !== 'win32') {
      expect((await stat(join(userRoot, 'mine', 'skills', 'demo', 'run.sh'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(userRoot, 'mine', 'skills', 'demo', 'SKILL.md'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(userRoot, 'mine'))).mode & 0o777).toBe(0o700)
    }
  })

  it('keeps the source description but never its name or order', async () => {
    await seedPreset(userRoot, 'source', { metadata: 'name: 源模式\ndescription: 只做检索。\norder: 1\n' })

    await ctx.agentPresets.copy('source', 'mine')

    // Two rows presenting identically is how a roster stops being a chooser,
    // and the shipped set's declared order is not the copy's to claim.
    const metadata = await readFile(join(userRoot, 'mine', METADATA_FILE), 'utf8')
    expect(metadata).toContain('description: 只做检索。')
    expect(metadata).not.toContain('name:')
    expect(metadata).not.toContain('order:')
    expect((await ctx.agentPresets.list()).find(preset => preset.id === 'mine'))
      .toMatchObject({ description: '只做检索。' })
  })

  it('stores the display name the author supplied', async () => {
    await ctx.agentPresets.copy('standard', 'mine', '我的模式')

    expect(await readFile(join(userRoot, 'mine', METADATA_FILE), 'utf8')).toContain('name: 我的模式')
    expect((await ctx.agentPresets.list()).find(preset => preset.id === 'mine'))
      .toMatchObject({ name: '我的模式' })
  })

  it('publishes no metadata file when there is nothing to publish', async () => {
    await seedPreset(userRoot, 'source')

    await ctx.agentPresets.copy('source', 'mine')

    // An empty metadata document would read as an intentional blank name;
    // absence is what "this preset publishes no display text" looks like.
    expect(existsSync(join(userRoot, 'mine', METADATA_FILE))).toBe(false)
    expect((await ctx.agentPresets.list()).find(preset => preset.id === 'mine')?.name).toBeUndefined()
  })

  it('refuses an id that could escape the preset root', async () => {
    for (const id of ['../escape', 'a/b', '/abs', '..', 'Upper']) {
      await expect(ctx.agentPresets.copy('standard', id)).rejects.toThrow(/must match/)
    }
    // Nothing was created for any of them.
    expect(existsSync(join(userRoot, 'escape'))).toBe(false)
  })

  it('refuses an id the roster already supplies, shipped ones included', async () => {
    await ctx.agentPresets.copy('standard', 'mine')

    await expect(ctx.agentPresets.copy('standard', 'mine')).rejects.toThrow(/already exists/)
    // A user directory named like a shipped preset would be shadowed by it.
    await expect(ctx.agentPresets.copy('standard', 'minimal')).rejects.toThrow(/already exists/)
  })

  it('refuses a directory that occupies the name without being a preset', async () => {
    await mkdir(join(userRoot, 'occupied'), { recursive: true })
    await writeFile(join(userRoot, 'occupied', 'README.txt'), 'nope\n')

    // Discovery does not list it (no composition file), so only the disk
    // check can refuse it with a readable error instead of a filesystem code.
    await expect(ctx.agentPresets.copy('standard', 'occupied')).rejects.toThrow(/already exists/)
    expect(await readFile(join(userRoot, 'occupied', 'README.txt'), 'utf8')).toBe('nope\n')
  })

  it('reports an unknown source rather than creating anything', async () => {
    await expect(ctx.agentPresets.copy('never-existed', 'mine')).rejects.toThrow(/not found/)
    expect(existsSync(join(userRoot, 'mine'))).toBe(false)
  })

  it('leaves nothing behind when the copy itself fails', async () => {
    const source = {
      id: 'gone',
      trust: 'user' as const,
      path: join(userRoot, 'gone', COMPOSITION_FILE),
    }

    // The source vanished between resolve and copy: the half-made target is
    // rolled back rather than left invisible to discovery.
    await expect(copyComposition(
      [{ path: userRoot, trust: 'user' as const }], source, 'mine',
    )).rejects.toThrow()
    expect(existsSync(join(userRoot, 'mine'))).toBe(false)
  })
})

describe('deleting a preset', () => {
  it('removes a locally authored one', async () => {
    await ctx.agentPresets.copy('standard', 'mine')

    await ctx.agentPresets.remove('mine')

    expect(existsSync(join(userRoot, 'mine'))).toBe(false)
    expect((await ctx.agentPresets.list()).some(preset => preset.id === 'mine')).toBe(false)
  })

  it('refuses to delete a shipped one', async () => {
    await expect(ctx.agentPresets.remove('standard'))
      .rejects.toThrow(/ships with the deployment/)
  })

  it('reports an unknown id rather than silently succeeding', async () => {
    await expect(ctx.agentPresets.remove('never-existed')).rejects.toThrow(/not found/)
  })
})

describe('a deployment with more than one user root', () => {
  it('refuses to delete a preset the writable root does not own', async () => {
    const second = await mkdtemp(join(tmpdir(), 'dsh-preset-second-'))
    roots.push(second)
    await seedPreset(second, 'elsewhere')
    const layered = new Context()
    layered.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await layered.plugin(Loader)
    layered.loader.builtins.include = Include
    await mountAgentPresets(layered, {
      default: 'standard',
      roots: [
        { path: userRoot, trust: 'user' as const },
        { path: second, trust: 'user' as const },
      ],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    // Writes go to the first user root, so a preset discovered from a later
    // one is `user` trust yet outside what deletion is allowed to touch —
    // `rm -r` on a directory this root does not own is the failure to avoid.
    await expect(layered.agentPresets.remove('elsewhere'))
      .rejects.toThrow(/does not live under the writable preset root/)
    expect(existsSync(join(second, 'elsewhere'))).toBe(true)
  })
})

describe('a deployment with no writable root', () => {
  it('says authoring is unavailable rather than guessing a directory', async () => {
    const readOnly = new Context()
    readOnly.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await readOnly.plugin(Loader)
    readOnly.loader.builtins.include = Include
    await mountAgentPresets(readOnly, {
      default: 'standard',
      roots: [{ path: join(FIXTURES, 'system'), trust: 'system' as const }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    expect(readOnly.agentPresets.authorable).toBe(false)
    await expect(readOnly.agentPresets.copy('standard', 'mine'))
      .rejects.toThrow(/no user-writable preset root/)
  })
})

describe('a user root that does not exist yet', () => {
  it('is created by the first copy', async () => {
    const absentRoot = await mkdtemp(join(tmpdir(), 'dsh-preset-absent-'))
    roots.push(absentRoot)
    const absent = join(absentRoot, 'nested', 'preset')
    const fresh = new Context()
    fresh.baseUrl = pathToFileURL(FIXTURES).href + '/'
    await fresh.plugin(Loader)
    fresh.loader.builtins.include = Include
    await mountAgentPresets(fresh, {
      default: 'standard',
      roots: [
        { path: join(FIXTURES, 'system'), trust: 'system' as const },
        { path: absent, trust: 'user' as const },
      ],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    await fresh.agentPresets.copy('standard', 'mine')

    expect(await readFile(join(absent, 'mine', COMPOSITION_FILE), 'utf8'))
      .toBe(await fresh.agentPresets.read('standard'))
  })
})

describe('display metadata beside a composition', () => {
  it('keeps a composition mountable when its metadata is unreadable', async () => {
    await ctx.agentPresets.copy('standard', 'mine')
    await writeFile(join(userRoot, 'mine', METADATA_FILE), 'name: [unclosed\n')

    // Presentation is not capability: discovery still yields the preset.
    const listed = (await ctx.agentPresets.list()).find(preset => preset.id === 'mine')
    expect(listed?.name).toBeUndefined()
    expect(await ctx.agentPresets.resolve('mine')).toMatchObject({ id: 'mine' })
  })
})

describe('the on-disk occupancy backstop', () => {
  it('refuses a directory the roster cannot see', async () => {
    // The service's roster check sees every id-shaped directory now, so this
    // is the race backstop: a directory appearing between the roster read and
    // the copy still gets the readable refusal, not a filesystem error code.
    await mkdir(join(userRoot, 'raced'), { recursive: true })
    const source = await ctx.agentPresets.resolve('standard')

    await expect(copyComposition(
      [{ path: userRoot, trust: 'user' as const }], source, 'raced',
    )).rejects.toThrow(/already exists/)
  })
})

describe('a ghost directory under the user root', () => {
  it('lists broken, blocks its id, and clears through remove', async () => {
    // The classic hand-edit: the composition file was deleted, the directory
    // stayed. It must not vanish from the roster — its id is still taken, so
    // there has to be something to see and delete.
    await mkdir(join(userRoot, 'ghost'), { recursive: true })
    await writeFile(join(userRoot, 'ghost', 'README.txt'), 'composition deleted by hand\n')

    const ghost = (await ctx.agentPresets.list()).find(preset => preset.id === 'ghost')
    expect(ghost?.broken).toMatch(/agent\.cordis\.yml is missing/)
    await expect(ctx.agentPresets.copy('standard', 'ghost')).rejects.toThrow(/already exists/)

    // remove is the way out the roster row offers; the id is claimable again.
    await ctx.agentPresets.remove('ghost')
    expect(existsSync(join(userRoot, 'ghost'))).toBe(false)
    await ctx.agentPresets.copy('standard', 'ghost')
    expect((await ctx.agentPresets.list()).map(preset => preset.id)).toContain('ghost')
    // A copy carries the whole preset directory, so a preset's own files
    // travel with it. This fixture's rows reach OUTSIDE that directory, which
    // no real preset does and which no copy can carry — so the claim here is
    // the reclaimed id and the restored composition, not the rows' targets.
    expect(existsSync(join(userRoot, 'ghost', COMPOSITION_FILE))).toBe(true)
  })
})
