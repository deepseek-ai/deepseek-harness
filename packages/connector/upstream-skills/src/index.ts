/**
 * Upstream skills of CLI app plugins: the Host Service `ctx.upstreamSkills` downloads the files that a plugin's entry
 * skill indexes from one directory of the vendor's GitHub repository at a pinned commit, verifies them, publishes them
 * in the DSH cache, and lists the entry skill over them once they are there.
 * @module @deepseek-ai/dsh-upstream-skills
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { parse as parseYaml } from 'yaml'
import { downloadSkillSet, writeFiles } from './archive.ts'
import type { UpstreamSkillsHandle, UpstreamSkillsRegistration, UpstreamSkillsState } from './types.ts'

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
   * and waits for `retry()`. The registration belongs to the calling plugin: unloading that plugin aborts the download
   * and removes the entry skill.
   * @param registration - the plugin's provider name, entry, pinned files, and optional skills directory.
   * @returns the handle the plugin's view observes and its check retries.
   * @throws when the entry has no skill name or description in its frontmatter, `skillsDir` is not a directory, or a
   *   skill provider named `name` is already registered.
   */
  register(registration: UpstreamSkillsRegistration): UpstreamSkillsHandle {
    const caller = this.ctx
    let provider!: UpstreamSkillProvider
    const withdraw = caller.skills.registerProvider((control) => {
      provider = new UpstreamSkillProvider(registration, this.config, control, caller.logger)
      return provider
    })
    provider.retry()
    return {
      directory: provider.directory,
      get state() { return provider.state },
      watch: listener => provider.watch(listener),
      retry: () => { provider.retry() },
      dispose: withdraw,
    }
  }
}

/** Lists the entry skill while its upstream files are in place, and owns their download. */
class UpstreamSkillProvider implements SkillProvider {
  readonly name: string
  readonly directory: string
  private readonly candidate: SkillCandidate
  private readonly content: string
  private readonly listeners = new Set<(state: UpstreamSkillsState) => void>()
  private running = false

  constructor(
    private readonly options: UpstreamSkillsRegistration,
    private readonly config: Config,
    private readonly control: SkillProviderControl,
    private readonly logger: Context['logger'],
  ) {
    this.name = options.name
    const { skillsDir } = options
    if (skillsDir === undefined) {
      this.directory = dshCachePath(options.name, `skills-${options.set.sha256.slice(0, 16)}`)
    } else {
      this.directory = resolve(skillsDir)
      const remedy = `set it to a directory holding the files of ${options.set.directory} at their repository paths`
      if (!this.installed()) throw new Error(`${options.name}: skillsDir ${skillsDir} is not a directory; ${remedy}`)
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

  get state(): UpstreamSkillsState {
    if (this.running) return 'downloading'
    return this.installed() ? 'installed' : 'failed'
  }

  list(): Promise<SkillCandidate[]> {
    return Promise.resolve(this.installed() ? [this.candidate] : [])
  }

  get(): Promise<SkillDefinition | undefined> {
    if (!this.installed()) return Promise.resolve(undefined)
    const { rank: _rank, locator: _locator, ...summary } = this.candidate
    return Promise.resolve({ ...summary, content: this.content })
  }

  watch(listener: (state: UpstreamSkillsState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  retry(): void {
    const { signal } = this.control
    if (this.state !== 'failed' || this.options.skillsDir !== undefined || signal.aborted) return
    this.running = true
    this.notify()
    void this.install(signal).then(
      () => { this.control.invalidate() },
      (error: unknown) => {
        if (signal.aborted) return
        // Another process may have published the directory while this download failed.
        if (this.installed()) this.control.invalidate()
        else this.logger.warn(`${this.name}: the upstream skills are not available`, error)
      },
    ).finally(() => {
      this.running = false
      if (!signal.aborted) this.notify()
    })
  }

  private installed(): boolean {
    return statSync(this.directory, { throwIfNoEntry: false })?.isDirectory() === true
  }

  private notify(): void {
    const { state } = this
    for (const listener of this.listeners) listener(state)
  }

  /** Download and verify the files, then publish them by renaming a sibling staging directory. */
  private async install(signal: AbortSignal): Promise<void> {
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
