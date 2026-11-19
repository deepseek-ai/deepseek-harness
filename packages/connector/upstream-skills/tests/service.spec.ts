/**
 * `ctx.upstreamSkills` lists a plugin's entry skill over its upstream files: a configured directory, downloads, retries,
 * withdrawal, and a profile's own directory, where the pin in place replaces the earlier ones.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import UpstreamSkills, { type Config, type UpstreamSkillsHandle, type UpstreamSkillSet, type UpstreamSkillsState } from '../src/index.ts'
import { KEPT, archivePath, pin, repository, serve, startHost, type ArchiveHost } from './harness.ts'

const renameHook = vi.hoisted(() => ({ before: undefined as ((from: string, to: string) => Promise<void>) | undefined }))
/** The one path whose removal fails with the given error, as a directory in use does on Windows. */
const removeHook = vi.hoisted(() => ({ refused: undefined as { readonly path: string; readonly error: Error } | undefined }))
/** Every directory listed through `readdir`, by the Service or by a test, in call order. */
const listHook = vi.hoisted(() => ({ listed: [] as string[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const before = renameHook.before
      renameHook.before = undefined
      await before?.(from, to)
      return actual.rename(from, to)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (removeHook.refused?.path === args[0]) throw removeHook.refused.error
      return actual.rm(...args)
    },
    readdir: (path: string) => {
      listHook.listed.push(path)
      return actual.readdir(path)
    },
  }
})

const ENTRY = '---\nname: vendor\ndescription: Vendor plugin guides.\n---\n\n# Vendor\n\nOpen `skills/alpha/SKILL.md`.\n'
const BODY = '# Vendor\n\nOpen `skills/alpha/SKILL.md`.'
/** The logger level that exports warnings; the default level keeps only errors and information. */
const WARN_LEVEL = 2
/** The HTTPS prefix the Service downloads from; the tests send its requests to the local archive host. */
const BASE = 'https://skills.test'

let host: ArchiveHost
let fixtures: string
let entry: string

beforeAll(async () => {
  host = await startHost()
  fixtures = await mkdtemp(join(tmpdir(), 'dsh-upstream-skills-entry-'))
  entry = join(fixtures, 'SKILL.md')
  await writeFile(entry, ENTRY)
})

afterAll(async () => {
  await host.close()
  await rm(fixtures, { recursive: true, force: true })
})

let ctx: Context
let home: string
let release: () => void

beforeEach(async () => {
  const request = fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => request(url.replace(BASE, host.base), init))
  ctx = new Context()
  await ctx.plugin(SkillRegistry)
  service = await load()
  host.routes = {}
  host.requests.length = 0
  home = await mkdtemp(join(tmpdir(), 'dsh-upstream-skills-home-'))
  vi.stubEnv('DSH_HOME', home)
  release = () => {}
})

afterEach(async () => {
  release()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  renameHook.before = undefined
  removeHook.refused = undefined
  listHook.listed.length = 0
  await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
})

const set = pin()
/** The directory name the pin is published under, and the name of a pin an earlier plugin version published. */
const CURRENT = `skills-${set.sha256.slice(0, 16)}`
const EARLIER = 'skills-0123456789abcdef'
const cache = () => join(home, 'cache', 'vendor')
const published = () => join(cache(), CURRENT)
const warning = (message: unknown, error: unknown) => ({ message, error })
const logged = () => ctx.logger.buffer.filter(entry => entry.type === 'warn').map(entry => warning(entry.args[0], entry.args[1]))
const warnings = (): unknown[] => logged().map(({ message }) => message)
/** Load the Service; `BASE` is its only source unless a test names others. */
const load = (config: Partial<Config> = {}) => ctx.plugin(UpstreamSkills, { skillsUrls: [BASE], skillsTimeoutMs: 10_000, ...config })
let service: Awaited<ReturnType<typeof load>>
/** Load the Service again with other sources. */
async function sources(config: Partial<Config>): Promise<void> {
  await service.dispose()
  service = await load(config)
}
const registration = (skillsDir?: string, pinned: UpstreamSkillSet = set, path = entry) => ({ name: 'vendor', entry: path, set: pinned, skillsDir })
const register = (skillsDir?: string, pinned: UpstreamSkillSet = set, path = entry): UpstreamSkillsHandle =>
  ctx.intercept('logger', { level: WARN_LEVEL }).upstreamSkills.register(registration(skillsDir, pinned, path))
/** Resolve with the state once no download runs. */
const settled = (skills: UpstreamSkillsHandle) => new Promise<UpstreamSkillsState>((resolve) => {
  if (skills.state !== 'downloading') {
    resolve(skills.state)
    return
  }
  const stop = skills.watch((state) => {
    if (state === 'downloading') return
    stop()
    resolve(state)
  })
})
/** Serve the archive only after `release()`, so a test observes the download while it runs. */
const gated = (body: Buffer) => {
  const gate = new Promise<void>((resolve) => { release = resolve })
  return async (response: Parameters<ReturnType<typeof serve>>[0]) => {
    await gate
    serve(body)(response)
  }
}
const listed = (directory: string) => [{
  name: 'vendor', path: entry, description: 'Vendor plugin guides.', invocation: { modelInvocable: true, userInvocable: true },
  source: 'bundled', provider: 'vendor', resourceBase: { kind: 'directory', path: directory },
}]

describe('Config', () => {
  it('defaults to GitHub with a two-minute limit and accepts only HTTPS URL prefixes without a query, fragment, or credentials', () => {
    expect(UpstreamSkills.Config({})).toEqual({ skillsUrls: ['https://codeload.github.com'], skillsTimeoutMs: 120_000 })
    expect(UpstreamSkills.Config({ skillsUrls: ['https://mirror.example/github'], skillsTimeoutMs: 1 }))
      .toEqual({ skillsUrls: ['https://mirror.example/github'], skillsTimeoutMs: 1 })
    for (const url of [
      'http://codeload.github.com', 'https://mirror.example/?a=1', 'https://mirror.example/#a', 'https://user@mirror.example',
      'https://mirror.example:bad', 'https://[', 'https://:',
    ]) {
      expect(() => UpstreamSkills.Config({ skillsUrls: [url] })).toThrow()
    }
    expect(() => UpstreamSkills.Config({ skillsUrls: [] })).toThrow()
    expect(() => UpstreamSkills.Config({ skillsTimeoutMs: 0 })).toThrow()
    expect(() => UpstreamSkills.Config({ skillsTimeoutMs: 1500.5 })).toThrow()
  })
})

describe('register', () => {
  it('lists the entry over a configured skills directory at once and downloads nothing', async () => {
    const skills = register(fixtures)
    expect(skills.directory).toBe(fixtures)
    expect(skills.state).toBe('installed')
    skills.retry()
    expect(await ctx.skills.list()).toEqual(listed(fixtures))
    expect(await ctx.skills.get('vendor')).toEqual({ ...listed(fixtures)[0], content: BODY })
    expect(host.requests).toEqual([])
  })

  it('names a skills directory that is missing at load, and reports one removed later as failed without downloading', async () => {
    const missing = join(home, 'missing')
    expect(() => register(missing))
      .toThrow(`vendor: skillsDir ${missing} is not a directory; set it to a directory holding the files of skills at their repository paths`)
    await mkdir(missing)
    const skills = register(missing)
    expect(await ctx.skills.list()).toEqual(listed(missing))
    await rm(missing, { recursive: true })
    expect(await ctx.skills.get('vendor')).toBeUndefined()
    expect(skills.state).toBe('failed')
    skills.retry()
    expect(skills.state).toBe('failed')
    expect(host.requests).toEqual([])
  })

  it('names an entry without a skill name and a description in YAML frontmatter', async () => {
    for (const [file, text] of [
      ['plain.md', '# Vendor\n'],
      ['scalar.md', '---\njust text\n---\n# Vendor\n'],
      ['nameless.md', '---\ndescription: Guides.\n---\n'],
      ['invalid-name.md', '---\nname: Vendor Guides\ndescription: Guides.\n---\n'],
      ['undescribed.md', '---\nname: vendor\ndescription: ""\n---\n'],
    ] as const) {
      const path = join(fixtures, file)
      await writeFile(path, text)
      expect(() => register(fixtures, set, path)).toThrow(`vendor: ${path} needs YAML frontmatter with a skill name and a description`)
    }
  })

  it('downloads at load and lists the entry once the files are published at their repository paths', async () => {
    host.routes[archivePath(set)] = gated(repository())
    const skills = register()
    const states: UpstreamSkillsState[] = []
    skills.watch((state) => { states.push(state) })
    expect(skills.directory).toBe(published())
    expect(skills.state).toBe('downloading')
    expect(await ctx.skills.list()).toEqual([])
    release()
    expect(await settled(skills)).toBe('installed')
    expect(states).toEqual(['installed'])
    expect(await ctx.skills.list()).toEqual(listed(published()))
    for (const [path, content] of Object.entries(KEPT)) expect(await readFile(join(published(), path), 'utf8')).toBe(content)
    expect((await readdir(join(published(), 'skills', 'alpha'))).toSorted()).toEqual(['SKILL.md', 'references'])
    expect(await readdir(cache())).toEqual([CURRENT])
    expect(host.requests).toEqual([archivePath(set)])
  })

  it('keeps every pin of the shared directory, which no profile owns', async () => {
    await mkdir(join(cache(), EARLIER), { recursive: true })
    host.routes[archivePath(set)] = serve(repository())
    const skills = register()
    expect(await settled(skills)).toBe('installed')
    expect(await ctx.skills.list()).toEqual(listed(published()))
    expect((await readdir(cache())).toSorted()).toEqual([EARLIER, CURRENT].toSorted())
  })

  it('tries the next skills URL after one fails and logs the failed prefix', async () => {
    host.routes[archivePath(set, '/mirror')] = serve(repository())
    await sources({ skillsUrls: [`${BASE}/missing`, `${BASE}/mirror/`] })
    const skills = register()
    expect(await settled(skills)).toBe('installed')
    expect(await ctx.skills.list()).toEqual(listed(published()))
    expect(warnings()).toEqual([`vendor: downloading the upstream skills from ${BASE}/missing failed`])
  })

  it('moves on from a skills URL that does not deliver the whole archive within the time limit', async () => {
    host.routes[archivePath(set, '/slow')] = (response) => { response.writeHead(200).write(repository().subarray(0, 64)) }
    host.routes[archivePath(set, '/mirror')] = serve(repository())
    // The limit applies to each URL, so it also bounds the mirror on a loaded machine.
    await sources({ skillsUrls: [`${BASE}/slow`, `${BASE}/mirror`], skillsTimeoutMs: 3_000 })
    const skills = register()
    expect(await settled(skills)).toBe('installed')
    expect(warnings()).toEqual([`vendor: downloading the upstream skills from ${BASE}/slow failed`])
    // Depending on which stream observes the abort first, the time limit arrives as the TimeoutError or as its cause.
    const timedOut = (error: unknown) => error instanceof Error && [error.name, error.cause instanceof Error ? error.cause.name : ''].includes('TimeoutError')
    expect(logged()[0]?.error).toSatisfy(timedOut)
  })

  it('refuses every source whose files differ from the pin, publishes nothing, and logs the failure', async () => {
    host.routes[archivePath(set, '/empty')] = (response) => { response.writeHead(204).end() }
    host.routes[archivePath(set, '/changed')] = serve(repository({ ...KEPT, LICENSE: 'MIT-License\n' }))
    await sources({ skillsUrls: [`${BASE}/empty`, `${BASE}/changed`] })
    const skills = register()
    expect(await settled(skills)).toBe('failed')
    expect(warnings()).toEqual([
      `vendor: downloading the upstream skills from ${BASE}/empty failed`,
      `vendor: downloading the upstream skills from ${BASE}/changed failed`,
      'vendor: the upstream skills are not available',
    ])
    expect(logged()[2]?.error).toMatchObject({
      message: `could not download the upstream skills of vendor/skills-repo at ${set.commit} from any skills URL`,
      cause: { message: `the kept files of ${BASE}/changed${archivePath(set)} do not match the pinned digest` },
    })
    expect(await readdir(home)).toEqual([])
    expect(await ctx.skills.list()).toEqual([])
  })

  it('retries a failed download without waiting for it, ignores a retry while one runs or after the files are in place', async () => {
    host.routes[archivePath(set)] = (response) => { response.writeHead(500).end() }
    const skills = register()
    expect(await settled(skills)).toBe('failed')
    host.routes[archivePath(set)] = gated(repository())
    const states: UpstreamSkillsState[] = []
    const stop = skills.watch((state) => { states.push(state) })
    skills.retry()
    expect(skills.state).toBe('downloading')
    skills.retry()
    release()
    expect(await settled(skills)).toBe('installed')
    stop()
    skills.retry()
    expect(states).toEqual(['downloading', 'installed'])
    expect(await ctx.skills.list()).toEqual(listed(published()))
    expect(host.requests).toEqual([archivePath(set), archivePath(set)])
  })

  it('keeps a directory another process published before load', async () => {
    await mkdir(published(), { recursive: true })
    const skills = register()
    expect(skills.state).toBe('installed')
    expect(await ctx.skills.list()).toEqual(listed(published()))
    expect(host.requests).toEqual([])
  })

  it('keeps a directory another process published while this one was renaming', async () => {
    host.routes[archivePath(set)] = serve(repository())
    renameHook.before = async (_from, to) => {
      await mkdir(to, { recursive: true })
      await writeFile(join(to, 'other'), 'published by another process')
    }
    const skills = register()
    expect(await settled(skills)).toBe('installed')
    expect(await readdir(published())).toEqual(['other'])
    expect(await readdir(cache())).toEqual([CURRENT])
  })

  it('lists the entry when another process publishes the directory while this download fails', async () => {
    const gate = new Promise<void>((resolve) => { release = resolve })
    host.routes[archivePath(set)] = async (response) => {
      await gate
      response.writeHead(500).end()
    }
    const skills = register()
    expect(await ctx.skills.list()).toEqual([])
    await mkdir(published(), { recursive: true })
    release()
    expect(await settled(skills)).toBe('installed')
    expect(await ctx.skills.list()).toEqual(listed(published()))
    expect(warnings()).toEqual([`vendor: downloading the upstream skills from ${BASE} failed`])
  })

  it('reports a publish that fails without another process publishing', async () => {
    host.routes[archivePath(set)] = serve(repository())
    renameHook.before = async (from) => { await rm(from, { recursive: true }) }
    const skills = register()
    expect(await settled(skills)).toBe('failed')
    expect(logged().at(-1)?.error).toMatchObject({ code: 'ENOENT' })
    expect(await readdir(cache())).toEqual([])
  })

  it('refuses a second registration under one name and keeps the first', async () => {
    register(fixtures)
    expect(() => register(fixtures)).toThrow('a skill provider named "vendor" is already registered')
    expect(await ctx.skills.list()).toEqual(listed(fixtures))
  })

  it('removes the entry and aborts a running download without a warning or a state change when the registering plugin unloads', async () => {
    let skills!: UpstreamSkillsHandle
    const app = Object.assign((inner: Context) => { skills = inner.upstreamSkills.register(registration()) }, { inject: ['upstreamSkills'] })
    host.routes[archivePath(set)] = gated(repository())
    const fiber = await ctx.intercept('logger', { level: WARN_LEVEL }).plugin(app)
    const states: UpstreamSkillsState[] = []
    skills.watch((state) => { states.push(state) })
    await vi.waitFor(() => { expect(host.requests).toEqual([archivePath(set)]) })
    await fiber.dispose()
    await vi.waitFor(() => { expect(skills.state).toBe('failed') })
    skills.retry()
    expect(states).toEqual([])
    expect(warnings()).toEqual([])
    expect(host.requests).toEqual([archivePath(set)])

    await mkdir(published(), { recursive: true })
    const loaded = await ctx.plugin(app)
    expect(await ctx.skills.list()).toEqual(listed(published()))
    await loaded.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('withdraws only the unloading plugin\'s entry', async () => {
    const other = join(fixtures, 'other.md')
    await writeFile(other, ENTRY.replace('name: vendor', 'name: other'))
    const app = (name: string, path: string) => Object.assign((inner: Context) => {
      inner.upstreamSkills.register({ name, entry: path, set, skillsDir: fixtures })
    }, { inject: ['upstreamSkills'] })
    const first = await ctx.plugin(app('vendor', entry))
    await ctx.plugin(app('other', other))
    expect((await ctx.skills.list()).map(skill => skill.name).toSorted()).toEqual(['other', 'vendor'])
    await first.dispose()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['other'])
  })

  it('withdraws the entry through the handle before the plugin unloads and aborts its download', async () => {
    host.routes[archivePath(set)] = gated(repository())
    const skills = register()
    await vi.waitFor(() => { expect(host.requests).toEqual([archivePath(set)]) })
    skills.dispose()
    await vi.waitFor(() => { expect(skills.state).toBe('failed') })
    skills.retry()
    expect(host.requests).toEqual([archivePath(set)])
    expect(warnings()).toEqual([])
    await mkdir(published(), { recursive: true })
    expect(await ctx.skills.list()).toEqual([])
  })
})

describe('register in a profile', () => {
  /** The Harness home of the profile, which differs from `$DSH_HOME` here. */
  const harness = () => join(home, 'harness')
  /** The directory of the `web` profile for the plugin. */
  const pins = () => join(harness(), 'cache', 'vendor', 'web')
  const entries = async (directory: string) => (await readdir(directory)).toSorted()

  beforeEach(() => {
    const dir = join(harness(), 'profiles', 'web')
    const profile: ProfileContext = {
      name: 'web', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: dir, cwd: home, home: harness(),
      startedBundles: [], overlayPaths: [], telemetryDisabledEnv: undefined,
    }
    ctx.provide('profileContext', profile)
  })

  it('publishes into the directory of the profile for the plugin, under the Harness home of the profile', async () => {
    host.routes[archivePath(set)] = serve(repository())
    const skills = register()
    expect(skills.directory).toBe(join(pins(), CURRENT))
    expect(await settled(skills)).toBe('installed')
    expect(await ctx.skills.list()).toEqual(listed(join(pins(), CURRENT)))
    for (const [path, content] of Object.entries(KEPT)) expect(await readFile(join(pins(), CURRENT, path), 'utf8')).toBe(content)
    expect(await readdir(pins())).toEqual([CURRENT])
    expect(await readdir(home)).toEqual(['harness'])
  })

  it('replaces the earlier pins of that directory once the new pin is published, and deletes nothing else', async () => {
    const staging = `.${CURRENT}-of-a-running-download`
    const untouched = [join(pins(), staging), join(pins(), '..', 'desktop', EARLIER), join(cache(), EARLIER)]
    for (const directory of [join(pins(), EARLIER), ...untouched]) await mkdir(directory, { recursive: true })
    host.routes[archivePath(set)] = gated(repository())
    const skills = register()
    expect(skills.state).toBe('downloading')
    expect(await entries(pins())).toEqual([staging, EARLIER].toSorted())
    release()
    expect(await settled(skills)).toBe('installed')
    await vi.waitFor(async () => { expect(await entries(pins())).toEqual([staging, CURRENT].toSorted()) })
    for (const directory of untouched) expect((await stat(directory)).isDirectory()).toBe(true)
    expect(warnings()).toEqual([])
  })

  it('replaces the earlier pins at load when the pin is already in place, without a download', async () => {
    for (const name of [CURRENT, EARLIER]) await mkdir(join(pins(), name), { recursive: true })
    const skills = register()
    expect(skills.state).toBe('installed')
    await vi.waitFor(async () => { expect(await readdir(pins())).toEqual([CURRENT]) })
    expect(await ctx.skills.list()).toEqual(listed(join(pins(), CURRENT)))
    expect(host.requests).toEqual([])
  })

  it('deletes the other pins once: it downloads a pin another process deleted again and keeps that process\'s pin', async () => {
    const other = 'skills-fedcba9876543210'
    await mkdir(join(pins(), EARLIER), { recursive: true })
    host.routes[archivePath(set)] = serve(repository())
    const skills = register()
    expect(await settled(skills)).toBe('installed')
    await vi.waitFor(async () => { expect(await readdir(pins())).toEqual([CURRENT]) })

    // Another process of the profile, running another plugin version, publishes its pin and deletes this one.
    await mkdir(join(pins(), other))
    await rm(join(pins(), CURRENT), { recursive: true })
    expect(skills.state).toBe('failed')
    const before = listHook.listed.length
    skills.retry()
    expect(await settled(skills)).toBe('installed')

    // The deletion starts by listing the directory, in the same turn in which the download settles.
    expect(listHook.listed.slice(before)).not.toContain(pins())
    expect(await entries(pins())).toEqual([CURRENT, other].toSorted())
    expect(await ctx.skills.list()).toEqual(listed(join(pins(), CURRENT)))
    expect(host.requests).toEqual([archivePath(set), archivePath(set)])
  })

  it('keeps the earlier pin while the new one cannot be downloaded', async () => {
    await mkdir(join(pins(), EARLIER), { recursive: true })
    host.routes[archivePath(set)] = (response) => { response.writeHead(500).end() }
    const skills = register()
    expect(await settled(skills)).toBe('failed')
    expect(await readdir(pins())).toEqual([EARLIER])
  })

  it('logs an earlier pin that cannot be deleted, keeps it, and still lists the entry', async () => {
    for (const name of [CURRENT, EARLIER]) await mkdir(join(pins(), name), { recursive: true })
    const refused = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    removeHook.refused = { path: join(pins(), EARLIER), error: refused }
    register()
    await vi.waitFor(() => {
      expect(logged()).toEqual([warning('vendor: could not delete the upstream skills this pin replaces', refused)])
    })
    expect(await entries(pins())).toEqual([EARLIER, CURRENT].toSorted())
    expect(await ctx.skills.list()).toEqual(listed(join(pins(), CURRENT)))
  })

  it('leaves a configured skills directory and its siblings as they are', async () => {
    const configured = join(pins(), CURRENT)
    for (const name of [CURRENT, EARLIER]) await mkdir(join(pins(), name), { recursive: true })
    const skills = register(configured)
    expect(skills.directory).toBe(configured)
    expect(await ctx.skills.list()).toEqual(listed(configured))
    expect(await entries(pins())).toEqual([EARLIER, CURRENT].toSorted())
    expect(host.requests).toEqual([])
  })
})
