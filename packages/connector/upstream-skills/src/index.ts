/**
 * Upstream skills of CLI app plugins: the Host Service `ctx.upstreamSkills` downloads the files that a plugin's entry
 * skill indexes from one directory of the vendor's GitHub repository at a pinned commit, verifies them, publishes them
 * in the DSH cache, and lists the entry skill over them once they are there. In a profile, each plugin's files have
 * a directory of their own, from which a registration deletes the other pins once its own pin is in place.
 * @module @deepseek-ai/dsh-upstream-skills
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Also declares `Context.profileContext`, the launcher-provided profile that owns a plugin's downloads.
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { parse as parseYaml } from 'yaml'
import { downloadSkillSet, writeFiles } from './archive.ts'
import type { UpstreamSkillsHandle, UpstreamSkillsRegistration } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The upstream skills CLI app plugins register. */
    upstreamSkills: UpstreamSkills
  }
}

/** Where every registered plugin's upstream files are downloaded from. */
export interface Config {
  /** Archive download prefixes tried in order; each serves `<owner>/<repository>/tar.gz/<commit>`. */
  skillsUrls: string[]
  /** How long one prefix may take to deliver the whole archive before the next one is tried. */
  skillsTimeoutMs: number
}

/** Accept a download prefix that parses as an HTTPS URL without credentials, a query, or a fragment. */
function skillsUrl(value: string): string {
  if (!/^https:\/\/[^\s?#@]+$/u.test(value) || !URL.canParse(value)) {
    throw new Error(`skillsUrls: ${value} is not an HTTPS URL without credentials, a query, or a fragment`)
  }
  return value
}

/** Holds what CLI app plugins register: for each plugin, the entry skill and the download of the upstream files it indexes. */
export default class UpstreamSkills extends Service {
  static inject = ['skills']

  /** `skillsUrls` defaults to GitHub's archive host. */
  static Config: z<Partial<Config>, Config> = z.object({
    skillsUrls: z.array(z.transform(z.string(), skillsUrl)).min(1).default(['https://codeload.github.com']),
    skillsTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'upstreamSkills')
  }

  /**
   * Register the calling plugin's entry skill and start downloading the upstream files unless they are in place. The
   * download starts at load so that a session without a client also gets the skill; a failure is logged as a warning
   * and the files stay missing until a call of `install()` downloads them. In a profile, the files go to that
   * profile's own directory for the plugin, and the registration deletes the other pins there once, the first time its
   * own pin is in place. The registration belongs to the calling plugin: unloading that plugin aborts the download and
   * removes the entry skill.
   * @param registration - the plugin's provider name, entry, pinned files, and optional skills directory.
   * @returns the handle the plugin reads the files' presence from and waits for the download through.
   * @throws when the entry has no skill name or description in its frontmatter, `skillsDir` is not a directory, or a
   *   skill provider named `name` is already registered.
   */
  register(registration: UpstreamSkillsRegistration): UpstreamSkillsHandle {
    const caller = this.ctx
    let provider!: UpstreamSkillProvider
    const withdraw = caller.skills.registerProvider((control) => {
      provider = new UpstreamSkillProvider(registration, this.config, control, caller.logger, caller.get('profileContext'))
      return provider
    })
    provider.start()
    provider.prune()
    return {
      directory: provider.directory,
      installed: () => provider.installed(),
      install: signal => provider.install(signal),
      dispose: withdraw,
    }
  }
}

/** The prefix of the directory name a pin is published under; the first 16 digits of its digest follow. */
const PIN_PREFIX = 'skills-'

/** One download of the upstream files: the controller that stops it, and its end. */
interface Download {
  readonly controller: AbortController
  /** Resolves once the files are in place; rejects with what stopped or failed the download while they are not. */
  readonly done: Promise<void>
}

/** Lists the entry skill while its upstream files are in place, and owns their download. */
class UpstreamSkillProvider implements SkillProvider {
  readonly name: string
  readonly directory: string
  /**
   * The profile's own directory for this plugin, from which {@link prune} deletes the other pins; the processes of
   * the profile share it. Undefined for a configured `skillsDir` and without a profile, where pins share
   * `$DSH_HOME/cache/<name>` and all stay.
   */
  private readonly pins: string | undefined
  /** Whether this registration has started deleting the other pins, which it does once. */
  private pruned = false
  private readonly candidate: SkillCandidate
  private readonly content: string
  /** The running download, which every `install()` call made while it runs waits for. */
  private download: Download | undefined

  constructor(
    private readonly options: UpstreamSkillsRegistration,
    private readonly config: Config,
    private readonly control: SkillProviderControl,
    private readonly logger: Context['logger'],
    profile: ProfileContext | undefined,
  ) {
    this.name = options.name
    const { skillsDir } = options
    const pin = `${PIN_PREFIX}${options.set.sha256.slice(0, 16)}`
    if (skillsDir !== undefined) {
      this.directory = resolve(skillsDir)
      if (!this.installed()) throw this.missing(skillsDir)
    } else if (profile === undefined) {
      this.directory = dshCachePath(options.name, pin)
    } else {
      // Only this profile's processes read these pins; one that still runs another plugin version loses its pin.
      this.pins = dshCachePath({ dshHome: profile.home }, options.name, profile.name)
      this.directory = join(this.pins, pin)
    }
    const entry = readEntry(options)
    this.content = entry.content
    this.candidate = {
      path: options.entry,
      name: entry.name,
      description: entry.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: options.name,
      rank: BUNDLED_SKILL_RANK,
      locator: options.entry,
      resourceBase: { kind: 'directory', path: this.directory },
    }
  }

  list(): Promise<SkillCandidate[]> {
    return Promise.resolve(this.installed() ? [this.candidate] : [])
  }

  get(): Promise<SkillDefinition | undefined> {
    if (!this.installed()) return Promise.resolve(undefined)
    const { rank: _rank, locator: _locator, ...summary } = this.candidate
    return Promise.resolve({ ...summary, content: this.content })
  }

  installed(): boolean {
    return statSync(this.directory, { throwIfNoEntry: false })?.isDirectory() === true
  }

  /** Start the download at load unless the files are in place. No caller waits for it; its failure is logged. */
  start(): void {
    if (!this.installed()) this.begin()
  }

  /** Wait for the files as {@link UpstreamSkillsHandle.install} states: join the running download or begin one. */
  async install(signal: AbortSignal): Promise<void> {
    if (this.installed()) return
    signal.throwIfAborted()
    this.control.signal.throwIfAborted()
    const { skillsDir } = this.options
    if (skillsDir !== undefined) throw this.missing(skillsDir)
    const download = this.download ?? this.begin()
    const stop = (): void => { download.controller.abort(signal.reason) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      await download.done
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }

  /**
   * Start deleting the other pins from the profile's own directory, once per registration: the first time this pin is
   * in place there. It returns at once, and does nothing without a profile, for a configured `skillsDir`, or after it
   * has started once. A registration whose pin a process running another plugin version deleted therefore downloads
   * it again without deleting that process's pin. A pin that cannot be deleted is logged as a warning and stays until
   * a later load.
   */
  prune(): void {
    const { pins } = this
    if (pins === undefined || this.pruned || !this.installed()) return
    this.pruned = true
    const current = basename(this.directory)
    void readdir(pins).then(async (names) => {
      for (const name of names) {
        if (name !== current && name.startsWith(PIN_PREFIX)) await rm(join(pins, name), { recursive: true, force: true })
      }
    }).catch((error: unknown) => {
      this.logger.warn(`${this.name}: could not delete the upstream skills this pin replaces`, error)
    })
  }

  /** The error for a configured `skillsDir` that is not a directory. */
  private missing(skillsDir: string): Error {
    const remedy = `set it to a directory holding the files of ${this.options.set.directory} at their repository paths`
    return new Error(`${this.name}: skillsDir ${skillsDir} is not a directory; ${remedy}`)
  }

  private begin(): Download {
    const controller = new AbortController()
    const done = this.run(controller)
    // The download started at load has no caller; `run` logs its failure.
    void done.catch(() => {})
    this.download = { controller, done }
    return this.download
  }

  /**
   * Run one download to its end. It stops when `controller` aborts or the registration is withdrawn, neither of which
   * is logged; any other failure is logged as a warning.
   */
  private async run(controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, this.control.signal])
    try {
      await this.publish(signal)
    } catch (error) {
      // Another process may have published the directory while this download failed.
      if (!this.installed()) {
        if (!signal.aborted) this.logger.warn(`${this.name}: the upstream skills are not available`, error)
        throw error
      }
    } finally {
      this.download = undefined
    }
    if (this.control.signal.aborted) return
    this.control.invalidate()
    this.prune()
  }

  /** Download and verify the files, then publish them by renaming a sibling staging directory. */
  private async publish(signal: AbortSignal): Promise<void> {
    const { skillsUrls, skillsTimeoutMs } = this.config
    const files = await downloadSkillSet(this.options.set, skillsUrls, skillsTimeoutMs, signal, (message, error) => {
      this.logger.warn(`${this.name}: ${message}`, error)
    })
    const staging = join(dirname(this.directory), `.${basename(this.directory)}-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    try {
      await writeFiles(files, staging)
      signal.throwIfAborted()
      // A directory another process published first is kept.
      await rename(staging, this.directory).catch((error: unknown) => { if (!this.installed()) throw error })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}

/** Read the entry's skill name and description from its YAML frontmatter, and its body after the frontmatter. */
function readEntry(options: UpstreamSkillsRegistration): { name: string; description: string; content: string } {
  const raw = readFileSync(options.entry, 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const metadata: unknown = frontmatter?.[1] === undefined ? undefined : parseYaml(frontmatter[1])
  const fields = new Map<string, unknown>(typeof metadata === 'object' && metadata !== null ? Object.entries(metadata) : [])
  const name = fields.get('name')
  const description = fields.get('description')
  if (frontmatter === null || typeof name !== 'string' || !isSkillName(name) || typeof description !== 'string' || description === '') {
    throw new Error(`${options.name}: ${options.entry} needs YAML frontmatter with a skill name and a description`)
  }
  return { name, description, content: raw.slice(frontmatter[0].length).trim() }
}
