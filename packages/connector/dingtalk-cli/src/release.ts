/** The pinned dws release the plugin installs into the DSH cache: the executable for the private PATH and the upstream skills. */

import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import { unzipSync } from 'fflate'
import { x as extract } from 'tar'

/** The executable name the plugin resolves on its private PATH. */
export const PROGRAM = 'dws'

/** The packaged skill entry that every skill root carries. */
const ENTRY = fileURLToPath(new URL('../skills/dingtalk/SKILL.md', import.meta.url))
/** `dws-skills.zip` entries the upstream skills directory keeps: the multi-mode skills and the root license files. */
const SKILL_FILES = /^(?:multi\/.+|LICENSE|NOTICE)$/u

const notExecutable = (binDir: string) =>
  new Error(`dingtalk: ${join(binDir, PROGRAM)} is not executable; set binDir to a directory containing an executable dws`)
const notSkillsDir = (skillsDir: string) =>
  new Error(`dingtalk: skillsDir ${skillsDir} is not a directory; set it to the extracted multi directory of dws-skills.zip`)

/** One release asset as the release's `checksums.txt` and asset list describe it. */
export interface DwsArchive {
  /** Asset name under the release tag. */
  readonly name: string
  /** Exact size in bytes; a response declaring another `Content-Length` is refused before its body is read. */
  readonly bytes: number
  /** Lowercase hexadecimal SHA-256 digest. */
  readonly sha256: string
}

/** One dws release: its executable archives keyed by `<platform>-<arch>`, and its platform-independent skills archive. */
export interface DwsReleaseManifest {
  readonly version: string
  readonly archives: Readonly<Partial<Record<string, DwsArchive>>>
  /** `dws-skills.zip`, whose `multi/` directory holds one directory per upstream skill. */
  readonly skills: DwsArchive
}

/** The release this plugin version installs. */
export const DWS_RELEASE: DwsReleaseManifest = {
  version: '1.0.64',
  archives: {
    'darwin-arm64': { name: 'dws-darwin-arm64.tar.gz', bytes: 16_333_159, sha256: '6a33ac7573343ba1cfb26ef126cfa1bdd17e126ddfdff49e450bae336107da23' },
    'darwin-x64': { name: 'dws-darwin-amd64.tar.gz', bytes: 17_987_992, sha256: 'c3c7cde614012ef217debaeb80b42857b0f49e2227bfd8d88718c7aff8718e26' },
    'linux-arm64': { name: 'dws-linux-arm64.tar.gz', bytes: 17_654_096, sha256: '351504a475b60c51a7b4abeb1a79f4e8de8b2ce1f06f97e0a5791a996bfe29a9' },
    'linux-x64': { name: 'dws-linux-amd64.tar.gz', bytes: 18_807_746, sha256: '68fd68effdb05c4f7af5771dfc7bf6c10d97d219b3fb992dc99165b198fddb32' },
  },
  skills: { name: 'dws-skills.zip', bytes: 3_260_967, sha256: '106999fc60c713aabbcf67fc183553d62feae210bf650a148ed38670468389de' },
}

/** Where dws and its skills come from. */
export interface DwsReleaseOptions {
  /** Absolute directory holding an executable `dws`; when set, the executable is not downloaded. */
  readonly binDir?: string | undefined
  /** Directory holding the upstream skills laid out as `multi/` in `dws-skills.zip`; when set, they are not downloaded. */
  readonly skillsDir?: string | undefined
  /** Release download prefixes tried in order; each serves `v<version>/<asset name>`. */
  readonly releaseUrls: readonly string[]
}

/** Locates dws and the `dingtalk` skill, and installs from the pinned release whichever is missing. */
export class DwsRelease {
  /** The directory registered on the private PATH: `binDir`, or `$DSH_HOME/cache/dingtalk/dws-<version>-<platform>-<arch>`. */
  readonly directory: string
  /**
   * The skill root `$DSH_HOME/cache/dingtalk/skill-<digest>`: a copy of the packaged `dingtalk/SKILL.md` and a
   * `dingtalk/guides` link to the upstream skills. The digest covers the entry and the link target, so a published root
   * never changes.
   */
  readonly skillRoot: string
  /** The upstream skills the guides link points to: `skillsDir`, or `$DSH_HOME/cache/dingtalk/dws-skills-<version>`. */
  private readonly guides: string
  private readonly entry: Buffer
  private readonly archive: DwsArchive | undefined

  /**
   * Publish the skill root at once when the upstream skills are already present, so the first skill catalog lists it.
   * @param options - the configured directories and download prefixes.
   * @param logger - receives one warning for each download source that fails.
   * @param release - the release to install; defaults to {@link DWS_RELEASE}.
   * @throws when `binDir` holds no executable `dws`, `skillsDir` is not a directory, the release has no archive for this
   *   platform, or the skill root cannot be written.
   */
  constructor(
    private readonly options: DwsReleaseOptions,
    private readonly logger: Context['logger'],
    private readonly release: DwsReleaseManifest = DWS_RELEASE,
  ) {
    if (options.binDir === undefined) {
      const platform = `${process.platform}-${process.arch}`
      this.archive = release.archives[platform]
      if (this.archive === undefined) throw new Error(`dingtalk: dws ${release.version} has no release archive for ${platform}; set binDir`)
      this.directory = dshCachePath('dingtalk', `dws-${release.version}-${platform}`)
    } else {
      this.directory = options.binDir
      if (!this.executable()) throw notExecutable(options.binDir)
    }
    if (options.skillsDir === undefined) {
      this.guides = dshCachePath('dingtalk', `dws-skills-${release.version}`)
    } else {
      this.guides = resolve(options.skillsDir)
      if (statSync(this.guides, { throwIfNoEntry: false })?.isDirectory() !== true) throw notSkillsDir(options.skillsDir)
    }
    this.entry = readFileSync(ENTRY)
    const digest = createHash('sha256').update(this.entry).update('\0').update(this.guides).digest('hex')
    this.skillRoot = dshCachePath('dingtalk', `skill-${digest.slice(0, 16)}`)
    if (existsSync(this.guides)) this.assemble()
  }

  /**
   * Check whether dws and the skill are in place.
   * @returns whether `directory` holds an executable `dws`, the upstream skills exist, and the skill root is published.
   */
  installed(): boolean {
    return this.executable() && existsSync(this.guides) && this.published()
  }

  /**
   * Download whichever of the executable archive and the skills archive is missing, verify its size and digest, extract it
   * beside its cache directory, and publish it there by rename; then publish the skill root. A directory that another
   * process published first is kept.
   * @param signal - aborts the downloads and the publishes.
   * @returns after `dws` is executable in `directory` and the skill root is published.
   * @throws when `binDir` or `skillsDir` lost its content, every source of an archive fails, or the executable archive holds
   *   no `dws`.
   */
  async install(signal: AbortSignal): Promise<void> {
    if (!this.executable()) {
      const archive = this.archive
      if (archive === undefined) throw notExecutable(this.directory)
      const data = await this.download(archive, signal)
      await this.publish(this.directory, () => this.executable(), signal, async (staging, into) => {
        const file = join(staging, archive.name)
        await writeFile(file, data, { mode: 0o600 })
        await extract({ file, cwd: into })
      })
      if (!this.executable()) throw new Error(`dingtalk: ${archive.name} holds no executable ${PROGRAM}`)
    }
    if (!existsSync(this.guides)) {
      if (this.options.skillsDir !== undefined) throw notSkillsDir(this.options.skillsDir)
      const data = await this.download(this.release.skills, signal)
      await this.publish(this.guides, () => existsSync(this.guides), signal, (_staging, into) => unpackSkills(data, into))
    }
    this.assemble()
  }

  private executable(): boolean {
    try { accessSync(join(this.directory, PROGRAM), constants.X_OK) } catch (_notExecutable) { return false }
    return true
  }

  private published(): boolean {
    return existsSync(join(this.skillRoot, 'dingtalk', 'SKILL.md'))
  }

  /** Fill a sibling staging directory, then rename its output to `directory` unless another process published one first. */
  private async publish(
    directory: string, present: () => boolean, signal: AbortSignal, fill: (staging: string, into: string) => Promise<void>,
  ): Promise<void> {
    const staging = join(dirname(directory), `.${basename(directory)}-${randomUUID()}`)
    const into = join(staging, 'out')
    await mkdir(into, { recursive: true })
    try {
      await fill(staging, into)
      signal.throwIfAborted()
      if (!present()) {
        await rm(directory, { recursive: true, force: true })
        await rename(into, directory).catch((error: unknown) => { if (!present()) throw error })
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /** Publish the skill root the same way, synchronously, so a constructor-time root is in place before the first catalog. */
  private assemble(): void {
    if (this.published()) return
    const staging = join(dirname(this.skillRoot), `.${basename(this.skillRoot)}-${randomUUID()}`)
    const skill = join(staging, 'dingtalk')
    mkdirSync(skill, { recursive: true })
    try {
      writeFileSync(join(skill, 'SKILL.md'), this.entry)
      symlinkSync(this.guides, join(skill, 'guides'), 'dir')
      rmSync(this.skillRoot, { recursive: true, force: true })
      try { renameSync(staging, this.skillRoot) } catch (error) { if (!this.published()) throw error }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  private async download(archive: DwsArchive, signal: AbortSignal): Promise<Buffer> {
    let failure: unknown
    for (const base of this.options.releaseUrls) {
      const url = `${base.replace(/\/+$/u, '')}/v${this.release.version}/${archive.name}`
      try {
        return await this.fetchArchive(url, archive, signal)
      } catch (error) {
        signal.throwIfAborted()
        failure = error
        this.logger.warn(`dingtalk: downloading ${archive.name} from ${new URL(url).origin} failed`, error)
      }
    }
    throw new Error(`dingtalk: could not download ${archive.name} of dws ${this.release.version} from any release URL`, { cause: failure })
  }

  private async fetchArchive(url: string, archive: DwsArchive, signal: AbortSignal): Promise<Buffer> {
    const response = await fetch(url, { signal })
    // The declared length bounds the body read into memory.
    if (!response.ok || response.headers.get('content-length') !== String(archive.bytes)) {
      await response.body?.cancel()
      throw new Error(`${url} returned HTTP ${String(response.status)} with ${response.headers.get('content-length') ?? 'no'} content length`)
    }
    const data = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(data).digest('hex') !== archive.sha256) {
      throw new Error(`${url} does not match the pinned ${archive.name} of dws ${this.release.version}`)
    }
    return data
  }
}

/** Write the multi-mode skills of `dws-skills.zip` and its root `LICENSE` and `NOTICE` into `into`. */
async function unpackSkills(data: Buffer, into: string): Promise<void> {
  for (const [name, content] of Object.entries(unzipSync(data, { filter: file => SKILL_FILES.test(file.name) }))) {
    if (name.endsWith('/')) continue
    const segments = name.replace(/^multi\//u, '').split('/')
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) {
      throw new Error(`dingtalk: dws-skills.zip holds the unsafe path ${name}`)
    }
    const file = join(into, ...segments)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}
