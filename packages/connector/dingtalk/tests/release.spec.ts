/**
 * dws and its skills: configured directories, or the pinned release downloaded, verified, and published into the cache,
 * and a profile's own cache directory, where the release in place replaces the earlier ones.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { create } from 'tar'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { DWS_RELEASE, DwsRelease, executableFileName, type DwsArchive, type DwsReleaseManifest } from '../src/release.ts'
import { createBinDir, createSkillsDir } from './harness.ts'

const renameHook = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  beforeSync: undefined as (() => void) | undefined,
}))
/** The one path whose removal fails with the given error, as a directory in use does on Windows. */
const removeHook = vi.hoisted(() => ({ refused: undefined as { readonly path: string; readonly error: Error } | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const before = renameHook.before
      renameHook.before = undefined
      await before?.()
      return actual.rename(from, to)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (removeHook.refused?.path === args[0]) throw removeHook.refused.error
      return actual.rm(...args)
    },
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const before = renameHook.beforeSync
      renameHook.beforeSync = undefined
      before?.()
      actual.renameSync(from, to)
    },
  }
})

const PLATFORM = `${process.platform}-${process.arch}`
/** The executable's file name in archives and directories: `dws`, or `dws.exe` on Windows. */
const DWS = executableFileName(process.platform)
const VERSION = '9.9.9'
/** Long enough for every fixture download; the timeout case sets its own. */
const TIMEOUT_MS = 5_000
const ASSET = 'dws-fixture.tar.gz'
const SKILLS = 'dws-skills.zip'
const ENTRY = fileURLToPath(new URL('../skills/dingtalk/SKILL.md', import.meta.url))

let server: Server
let base: string
let routes: Record<string, (response: ServerResponse) => void | Promise<void>>
let fixtures: string
/** Offline skills for the executable cases, so their installs download only the executable archive. */
let skillsDir: string

/** Pack the given files, executable when named {@link DWS}, into a gzip tarball and return its bytes. */
async function pack(files: Record<string, string>): Promise<Buffer> {
  const source = await mkdtemp(join(fixtures, 'source-'))
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(source, name), content)
    if (name === DWS) await chmod(join(source, name), 0o755)
  }
  const file = join(fixtures, `${randomUUID()}.tar.gz`)
  await create({ gzip: true, cwd: source, file }, Object.keys(files))
  return readFile(file)
}

const zip = (files: Zippable): Buffer => Buffer.from(zipSync(files))
const pinned = (name: string, data: Buffer): DwsArchive => ({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })

function manifest(archive: Buffer, skills: Buffer): DwsReleaseManifest {
  return { version: VERSION, archives: { [PLATFORM]: pinned(ASSET, archive) }, skills: pinned(SKILLS, skills) }
}

const serve = (body: Buffer) => (response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) }).end(body)
}
const asset = (prefix: string, name = ASSET) => `/${prefix}/v${VERSION}/${name}`

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-release-'))
  skillsDir = await createSkillsDir()
  server = createServer((request, response) => {
    const route = routes[request.url ?? '']
    if (route === undefined) response.writeHead(404).end('not found')
    else void route(response)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  await rm(fixtures, { recursive: true, force: true })
  await rm(skillsDir, { recursive: true, force: true })
})

let ctx: Context
let home: string
let binDir: string

beforeEach(async () => {
  ctx = new Context()
  routes = {}
  home = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-home-'))
  binDir = await createBinDir()
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  renameHook.before = undefined
  renameHook.beforeSync = undefined
  removeHook.refused = undefined
  await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(binDir, { recursive: true, force: true })
})

const signal = () => new AbortController().signal
const cache = () => join(home, 'cache', 'dingtalk')
const cached = async (): Promise<string[]> => (await readdir(cache())).toSorted()
const logged = () => ctx.logger.buffer.filter(message => message.type === 'warn')
  .map((message): { message: unknown; error: unknown } => ({ message: message.args[0], error: message.args[1] }))
const warnings = (): unknown[] => logged().map(({ message }) => message)
/** The warning of an installation that failed for another reason than an abort. */
const NOT_INSTALLED = 'dingtalk: could not install dws and its skills'
/** Entries an earlier plugin version published into a cache directory. */
const EARLIER = [`dws-1.0.0-${PLATFORM}`, 'dws-skills-1.0.0', 'skill-0123456789abcdef']
/** The logger level that exports warnings; the default level keeps only errors and information. */
const WARN_LEVEL = 2
const logger = () => ctx.intercept('logger', { level: WARN_LEVEL }).logger
/** A release that downloads only its executable archive. */
const executableRelease = (archive: Buffer, releaseUrls: string[]) =>
  new DwsRelease({ skillsDir, releaseUrls, releaseTimeoutMs: TIMEOUT_MS }, logger(), manifest(archive, Buffer.alloc(0)))
/** A release that downloads only its skills archive. */
const skillsRelease = (skills: Buffer, releaseUrls: string[]) =>
  new DwsRelease({ binDir, releaseUrls, releaseTimeoutMs: TIMEOUT_MS }, logger(), manifest(Buffer.alloc(0), skills))

describe('the dws and skill locations', () => {
  it('names the executable file dws, and dws.exe on Windows', () => {
    expect(executableFileName('win32')).toBe('dws.exe')
    expect(executableFileName('darwin')).toBe('dws')
  })

  it('accepts a configured executable and names its missing executable with the remedy', async () => {
    const configured = new DwsRelease({ binDir, skillsDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger)
    expect(configured.directory).toBe(binDir)
    expect(configured.installed()).toBe(true)
    expect(() => new DwsRelease({ binDir: home, skillsDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger))
      .toThrow(`dingtalk: ${join(home, DWS)} is not executable; set binDir to a directory containing an executable ${DWS}`)

    await rm(join(binDir, DWS))
    await expect(configured.install(signal())).rejects.toThrow(`dingtalk: ${join(binDir, DWS)} is not executable`)
  })

  it('names a platform the release has no archive for', () => {
    const unsupported = { ...manifest(Buffer.alloc(0), Buffer.alloc(0)), archives: {} }
    expect(() => new DwsRelease({ releaseUrls: [base], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger, unsupported))
      .toThrow(`dingtalk: dws ${VERSION} has no release archive for ${PLATFORM}; set binDir`)
  })

  it.runIf(DWS_RELEASE.archives[PLATFORM] !== undefined)('writes nothing at load while the managed dws and skills are missing', async () => {
    const managed = new DwsRelease({ releaseUrls: [base], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger)
    expect(managed.directory).toBe(join(cache(), `dws-${DWS_RELEASE.version}-${PLATFORM}`))
    expect(managed.skillRoot).toMatch(/[\\/]cache[\\/]dingtalk[\\/]skill-[0-9a-f]{16}$/u)
    expect(managed.installed()).toBe(false)
    expect(await readdir(home)).toEqual([])
  })

  it('publishes the skill root at load from configured skills, one root per entry and skills directory', async () => {
    const managed = new DwsRelease({ binDir, skillsDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger)
    expect(managed.installed()).toBe(true)
    expect(await readFile(join(managed.skillRoot, 'dingtalk', 'SKILL.md'))).toEqual(await readFile(ENTRY))
    expect(await readlink(join(managed.skillRoot, 'dingtalk', 'guides'))).toBe(skillsDir)
    expect(await readFile(join(managed.skillRoot, 'dingtalk', 'guides', 'dingtalk-shared', 'SKILL.md'), 'utf8')).toContain('# Fixture guide')

    const relativeDir = relative(process.cwd(), skillsDir)
    const relocated = new DwsRelease({ binDir, skillsDir: relativeDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger)
    expect(relocated.skillRoot).toBe(managed.skillRoot)
    const otherDir = await createSkillsDir()
    onTestFinished(() => rm(otherDir, { recursive: true, force: true }))
    const other = new DwsRelease({ binDir, skillsDir: otherDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger)
    expect(await readlink(join(other.skillRoot, 'dingtalk', 'guides'))).toBe(otherDir)
    expect(await cached()).toEqual([basename(managed.skillRoot), basename(other.skillRoot)].toSorted())
  })

  it('names a configured skills directory that is missing at load or at install', async () => {
    const file = join(home, 'file')
    await writeFile(file, '')
    for (const missing of [join(home, 'missing'), file]) {
      expect(() => new DwsRelease({ binDir, skillsDir: missing, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger))
        .toThrow(`dingtalk: skillsDir ${missing} is not a directory; set it to the extracted multi directory of dws-skills.zip`)
    }

    const removed = await createSkillsDir()
    const managed = new DwsRelease({ binDir, skillsDir: removed, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger)
    expect(managed.installed()).toBe(true)
    await rm(removed, { recursive: true })
    expect(managed.installed()).toBe(false)
    await expect(managed.install(signal())).rejects.toThrow(`dingtalk: skillsDir ${removed} is not a directory`)
  })

  it('republishes a skill root that lost its entry', async () => {
    const managed = new DwsRelease({ binDir, skillsDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger)
    await rm(join(managed.skillRoot, 'dingtalk', 'SKILL.md'))
    expect(managed.installed()).toBe(false)

    await managed.install(signal())

    expect(managed.installed()).toBe(true)
    expect(await cached()).toEqual([basename(managed.skillRoot)])
  })

  it('keeps a skill root another process published while this one was renaming, and reports a failed publish', async () => {
    const managed = new DwsRelease({ binDir, skillsDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS }, ctx.logger)
    await rm(managed.skillRoot, { recursive: true })
    renameHook.beforeSync = () => {
      mkdirSync(join(managed.skillRoot, 'dingtalk'), { recursive: true })
      writeFileSync(join(managed.skillRoot, 'dingtalk', 'SKILL.md'), 'published')
    }
    await managed.install(signal())
    expect(await readFile(join(managed.skillRoot, 'dingtalk', 'SKILL.md'), 'utf8')).toBe('published')
    expect(await cached()).toEqual([basename(managed.skillRoot)])

    await rm(managed.skillRoot, { recursive: true })
    renameHook.beforeSync = () => { throw new Error('rename failed') }
    await expect(managed.install(signal())).rejects.toThrow('rename failed')
    expect(await cached()).toEqual([])
  })
})

describe('installing the pinned executable', () => {
  it('downloads from the next source after one fails, then publishes the verified archive', async () => {
    const archive = await pack({ [DWS]: '#!/bin/sh\necho fixture\n', NOTICE: 'notice' })
    routes[asset('mirror')] = serve(archive)
    const managed = executableRelease(archive, [`${base}/missing`, `${base}/mirror/`])

    await managed.install(signal())

    expect(managed.installed()).toBe(true)
    expect(await readFile(join(managed.directory, DWS), 'utf8')).toBe('#!/bin/sh\necho fixture\n')
    expect(await cached()).toEqual([`dws-${VERSION}-${PLATFORM}`, basename(managed.skillRoot)].toSorted())
    expect(warnings()).toEqual([`dingtalk: downloading ${ASSET} from ${base} failed`])
  })

  it('tries the next source once one has not delivered the archive within the timeout', async () => {
    const archive = await pack({ [DWS]: 'fixture' })
    const stalled: ServerResponse[] = []
    routes[asset('stalled')] = (response) => { stalled.push(response) }
    routes[asset('mirror')] = serve(archive)
    onTestFinished(() => { for (const response of stalled) response.destroy() })
    const sources = [`${base}/stalled`, `${base}/mirror`]
    const managed = new DwsRelease({ skillsDir, releaseUrls: sources, releaseTimeoutMs: 50 }, logger(), manifest(archive, Buffer.alloc(0)))

    await managed.install(signal())

    expect(managed.installed()).toBe(true)
    expect(stalled).toHaveLength(1)
    expect(warnings()).toEqual([`dingtalk: downloading ${ASSET} from ${base} failed`])
  })

  it('refuses responses whose length, digest, or body differ from the pinned archive', async () => {
    const archive = await pack({ [DWS]: 'fixture' })
    const altered = Buffer.from(archive)
    altered[altered.length - 1] = altered.at(-1)! ^ 0xff
    routes[asset('longer')] = serve(Buffer.concat([archive, Buffer.from('x')]))
    routes[asset('altered')] = serve(altered)
    routes[asset('empty')] = (response) => { response.writeHead(204).end() }
    const managed = executableRelease(archive, ['longer', 'altered', 'empty'].map(prefix => `${base}/${prefix}`))

    const failure = await managed.install(signal()).then(() => undefined, (reason: unknown) => reason as Error)
    expect(failure?.message).toBe(`dingtalk: could not download ${ASSET} of dws ${VERSION} from any release URL`)
    expect((failure?.cause as Error).message).toBe(`${base}${asset('empty')} returned HTTP 204 with no content length`)
    expect(warnings()).toEqual([...Array.from({ length: 3 }, () => `dingtalk: downloading ${ASSET} from ${base} failed`), NOT_INSTALLED])
    expect(logged().at(-1)?.error).toBe(failure)
    expect(managed.installed()).toBe(false)
    expect(await cached()).toEqual([basename(managed.skillRoot)])
  })

  it('stops at an abort without trying the next source', async () => {
    const archive = await pack({ [DWS]: 'fixture' })
    routes[asset('mirror')] = serve(archive)
    const managed = executableRelease(archive, [`${base}/mirror`, `${base}/other`])
    const abort = new AbortController()
    abort.abort(new Error('plugin disposed'))

    await expect(managed.install(abort.signal)).rejects.toThrow('plugin disposed')
    expect(warnings()).toEqual([])
  })

  it('keeps a directory another process published first', async () => {
    const archive = await pack({ [DWS]: 'downloaded' })
    const managed = executableRelease(archive, [`${base}/mirror`])
    routes[asset('mirror')] = async (response) => {
      await mkdir(managed.directory, { recursive: true })
      await writeFile(join(managed.directory, DWS), 'published', { mode: 0o755 })
      serve(archive)(response)
    }

    await managed.install(signal())

    expect(await readFile(join(managed.directory, DWS), 'utf8')).toBe('published')
    expect(await cached()).toEqual([`dws-${VERSION}-${PLATFORM}`, basename(managed.skillRoot)].toSorted())
  })

  it('deletes nothing from the shared cache directory, which no profile owns', async () => {
    for (const name of EARLIER) await mkdir(join(cache(), name), { recursive: true })
    const archive = await pack({ [DWS]: 'downloaded' })
    routes[asset('mirror')] = serve(archive)
    const managed = executableRelease(archive, [`${base}/mirror`])

    await managed.install(signal())
    await managed.prune()

    expect(managed.installed()).toBe(true)
    expect(await cached()).toEqual([...EARLIER, `dws-${VERSION}-${PLATFORM}`, basename(managed.skillRoot)].toSorted())
  })

  it('keeps the directory another process published while this one was renaming', async () => {
    const archive = await pack({ [DWS]: 'downloaded' })
    routes[asset('mirror')] = serve(archive)
    const managed = executableRelease(archive, [`${base}/mirror`])
    renameHook.before = async () => {
      await mkdir(managed.directory, { recursive: true })
      await writeFile(join(managed.directory, DWS), 'published', { mode: 0o755 })
    }

    await managed.install(signal())

    expect(await readFile(join(managed.directory, DWS), 'utf8')).toBe('published')
  })

  // Windows has no execute permission bit: `access(X_OK)` only checks that the file exists.
  it.skipIf(process.platform === 'win32')('replaces a cache directory that holds no executable dws', async () => {
    const archive = await pack({ [DWS]: 'downloaded' })
    routes[asset('mirror')] = serve(archive)
    const managed = executableRelease(archive, [`${base}/mirror`])
    await mkdir(managed.directory, { recursive: true })
    await writeFile(join(managed.directory, DWS), 'stale', { mode: 0o644 })

    await managed.install(signal())

    expect(await readFile(join(managed.directory, DWS), 'utf8')).toBe('downloaded')
  })

  it('reports a failed publish and an archive without dws', async () => {
    const archive = await pack({ [DWS]: 'downloaded' })
    routes[asset('mirror')] = serve(archive)
    const managed = executableRelease(archive, [`${base}/mirror`])
    renameHook.before = () => Promise.reject(new Error('rename failed'))
    await expect(managed.install(signal())).rejects.toThrow('rename failed')
    expect(await cached()).toEqual([basename(managed.skillRoot)])
    expect(warnings()).toEqual([NOT_INSTALLED])
    expect(logged()[0]?.error).toMatchObject({ message: 'rename failed' })

    const readme = await pack({ 'README.md': 'no binary' })
    routes[asset('readme')] = serve(readme)
    const empty = executableRelease(readme, [`${base}/readme`])
    await expect(empty.install(signal())).rejects.toThrow(`dingtalk: ${ASSET} holds no executable ${DWS}`)
  })
})

describe('installing a zip release archive, the Windows form', () => {
  const ZIP = 'dws-fixture.zip'
  const zipRelease = (archive: Buffer, releaseUrls: string[]) => new DwsRelease(
    { skillsDir, releaseUrls, releaseTimeoutMs: TIMEOUT_MS }, logger(),
    { version: VERSION, archives: { [PLATFORM]: pinned(ZIP, archive) }, skills: pinned(SKILLS, Buffer.alloc(0)) },
  )

  it('publishes the executable at the archive root and leaves the other files', async () => {
    const archive = zip({ [DWS]: strToU8('zipped'), 'README.md': strToU8('readme') })
    routes[asset('mirror', ZIP)] = serve(archive)
    const managed = zipRelease(archive, [`${base}/mirror`])

    await managed.install(signal())

    expect(await readdir(managed.directory)).toEqual([DWS])
    expect(await readFile(join(managed.directory, DWS), 'utf8')).toBe('zipped')
  })

  it('reports a zip archive without the executable', async () => {
    const archive = zip({ 'README.md': strToU8('no binary') })
    routes[asset('mirror', ZIP)] = serve(archive)

    await expect(zipRelease(archive, [`${base}/mirror`]).install(signal())).rejects.toThrow(`dingtalk: ${ZIP} holds no executable ${DWS}`)
  })
})

describe('installing the pinned skills', () => {
  it('keeps the multi-mode skills and the license files, then links them from the skill root', async () => {
    const skills = zip({
      multi: { 'dingtalk-fixture': { 'SKILL.md': strToU8('# fixture'), scripts: { 'run.py': strToU8('print(1)') } } },
      mono: { 'SKILL.md': strToU8('# mono') },
      LICENSE: strToU8('license'),
      NOTICE: strToU8('notice'),
      'README.md': strToU8('readme'),
    })
    routes[asset('mirror', SKILLS)] = serve(skills)
    const managed = skillsRelease(skills, [`${base}/missing`, `${base}/mirror`])
    expect(managed.installed()).toBe(false)

    await managed.install(signal())

    expect(managed.installed()).toBe(true)
    const guides = join(cache(), `dws-skills-${VERSION}`)
    expect(await cached()).toEqual([`dws-skills-${VERSION}`, basename(managed.skillRoot)].toSorted())
    expect((await readdir(guides, { recursive: true })).map(path => path.replaceAll('\\', '/')).toSorted()).toEqual([
      'LICENSE', 'NOTICE', 'dingtalk-fixture', 'dingtalk-fixture/SKILL.md', 'dingtalk-fixture/scripts', 'dingtalk-fixture/scripts/run.py',
    ])
    expect(await readlink(join(managed.skillRoot, 'dingtalk', 'guides'))).toBe(guides)
    expect(await readFile(join(managed.skillRoot, 'dingtalk', 'guides', 'dingtalk-fixture', 'scripts', 'run.py'), 'utf8')).toBe('print(1)')
    expect(warnings()).toEqual([`dingtalk: downloading ${SKILLS} from ${base} failed`])
  })

  it.each(['multi/../escape.md', 'multi//empty.md', 'multi/./dot.md', 'multi/back\\slash.md'])(
    'refuses a skills archive holding the unsafe path %s',
    async (name) => {
      const skills = zip({ [name]: strToU8('unsafe') })
      routes[asset('mirror', SKILLS)] = serve(skills)
      const managed = skillsRelease(skills, [`${base}/mirror`])

      await expect(managed.install(signal())).rejects.toThrow(`dingtalk: dws-skills.zip holds the unsafe path ${name}`)

      expect(managed.installed()).toBe(false)
      expect(await cached()).toEqual([])
    },
  )
})

describe("a profile's own cache directory", () => {
  /** The Harness home of the profile, which differs from `$DSH_HOME` here. */
  const harness = () => join(home, 'harness')
  const owned = () => join(harness(), 'cache', 'dingtalk', 'web')
  const profile = () => ({ home: harness(), name: 'web' })
  const entries = async (directory: string): Promise<string[]> => (await readdir(directory)).toSorted()
  const earlier = async (): Promise<void> => {
    for (const name of EARLIER) await mkdir(join(owned(), name), { recursive: true })
  }
  /** A release whose dws and skills archives the `mirror` prefix serves. */
  async function served(): Promise<DwsRelease> {
    const archive = await pack({ [DWS]: 'downloaded' })
    const skills = zip({ multi: { 'dingtalk-fixture': { 'SKILL.md': strToU8('# fixture') } }, LICENSE: strToU8('license') })
    routes[asset('mirror')] = serve(archive)
    routes[asset('mirror', SKILLS)] = serve(skills)
    return new DwsRelease({ releaseUrls: [`${base}/mirror`], releaseTimeoutMs: TIMEOUT_MS, profile: profile() }, logger(), manifest(archive, skills))
  }
  /** The entries {@link served} publishes. */
  const published = (managed: DwsRelease) => [`dws-${VERSION}-${PLATFORM}`, `dws-skills-${VERSION}`, basename(managed.skillRoot)]

  it('receives dws, the skills, and the skill root, under the Harness home of the profile', async () => {
    const managed = await served()
    expect(managed.directory).toBe(join(owned(), `dws-${VERSION}-${PLATFORM}`))
    expect(dirname(managed.skillRoot)).toBe(owned())

    await managed.install(signal())

    expect(managed.installed()).toBe(true)
    expect(await entries(owned())).toEqual(published(managed).toSorted())
    expect(await readFile(join(managed.directory, DWS), 'utf8')).toBe('downloaded')
    expect(await readlink(join(managed.skillRoot, 'dingtalk', 'guides'))).toBe(join(owned(), `dws-skills-${VERSION}`))
    expect(await readdir(home)).toEqual(['harness'])
  })

  it('loses the earlier releases once this one is installed, and nothing else', async () => {
    const staging = `.dws-${VERSION}-${PLATFORM}-of-a-running-installation`
    const untouched = [join(owned(), staging), join(owned(), 'notes'), join(owned(), '..', 'desktop', EARLIER[0]!), join(cache(), EARLIER[0]!)]
    await earlier()
    for (const directory of untouched) await mkdir(directory, { recursive: true })
    const managed = await served()

    await managed.install(signal())

    await vi.waitFor(async () => { expect(await entries(owned())).toEqual([staging, 'notes', ...published(managed)].toSorted()) })
    for (const directory of untouched) expect(await readdir(directory)).toEqual([])
    expect(warnings()).toEqual([])
  })

  it('loses at load what a release already in place does not use, a downloaded dws that binDir replaces included', async () => {
    await earlier()
    await mkdir(join(owned(), `dws-${DWS_RELEASE.version}-${PLATFORM}`))
    const managed = new DwsRelease({ binDir, skillsDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS, profile: profile() }, logger())
    expect(managed.installed()).toBe(true)

    await managed.prune()

    expect(await readdir(owned())).toEqual([basename(managed.skillRoot)])
    expect(await readdir(binDir)).toEqual([DWS])
    expect(await readdir(skillsDir)).toEqual(['dingtalk-shared'])
  })

  it('keeps the skills that an earlier skill root links to when it deletes that root', async () => {
    const linked = await createSkillsDir()
    onTestFinished(() => rm(linked, { recursive: true, force: true }))
    const root = join(owned(), EARLIER[2]!, 'dingtalk')
    await mkdir(root, { recursive: true })
    await symlink(linked, join(root, 'guides'), 'junction')
    const options = { binDir, skillsDir: linked, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS, profile: profile() }
    const managed = new DwsRelease(options, logger())

    await managed.prune()

    expect(await readdir(owned())).toEqual([basename(managed.skillRoot)])
    expect(await readFile(join(linked, 'dingtalk-shared', 'SKILL.md'), 'utf8')).toContain('# Fixture guide')
    const guide = join(managed.skillRoot, 'dingtalk', 'guides', 'dingtalk-shared', 'SKILL.md')
    expect(await readFile(guide, 'utf8')).toContain('# Fixture guide')
    expect(warnings()).toEqual([])
  })

  it('deletes the other releases once, so a process whose release another one deleted installs it again beside that one', async () => {
    const managed = await served()
    await managed.install(signal())
    await vi.waitFor(async () => { expect(await entries(owned())).toEqual(published(managed).toSorted()) })
    await rm(managed.directory, { recursive: true })
    await earlier()

    await managed.install(signal())
    await managed.prune()

    expect(managed.installed()).toBe(true)
    expect(await entries(owned())).toEqual([...EARLIER, ...published(managed)].toSorted())
  })

  it('keeps the earlier releases while this one is not installed', async () => {
    await earlier()
    const managed = await served()
    routes = {}

    await expect(managed.install(signal())).rejects.toThrow(`dingtalk: could not download ${ASSET} of dws ${VERSION} from any release URL`)
    await managed.prune()

    expect(managed.installed()).toBe(false)
    expect(await entries(owned())).toEqual(EARLIER.toSorted())
  })

  it('logs an entry that cannot be deleted, keeps it, and stays installed', async () => {
    await earlier()
    const refused = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    removeHook.refused = { path: join(owned(), EARLIER[0]!), error: refused }
    const managed = new DwsRelease({ binDir, skillsDir, releaseUrls: [], releaseTimeoutMs: TIMEOUT_MS, profile: profile() }, logger())

    await managed.prune()

    expect(logged()).toEqual([{ message: 'dingtalk: could not delete the dws files this release replaces', error: refused }])
    expect(await entries(owned())).toContain(EARLIER[0])
    expect(managed.installed()).toBe(true)
  })
})
