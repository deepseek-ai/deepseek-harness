/**
 * Upstream skills of CLI app plugins: download the files that a plugin's entry skill indexes from one directory of the
 * vendor's GitHub repository at a pinned commit, verify them, publish them in the DSH cache, and list the entry skill
 * over them once they are there.
 * @module @deepseek-ai/dsh-upstream-skills
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { parse as parseYaml } from 'yaml'
import { downloadSkillSet, writeFiles } from './archive.ts'
import type { UpstreamSkills, UpstreamSkillSet, UpstreamSkillsState } from './types.ts'

export type * from './types.ts'

/** Where the upstream files come from; a plugin adds these fields to its own `Config`. */
export interface UpstreamSkillsConfig {
  /** Directory holding the kept files at their repository paths; when set, nothing is downloaded. */
  skillsDir?: string
  /** Archive download prefixes tried in order; each serves `<owner>/<repository>/tar.gz/<commit>`. */
  skillsUrls: string[]
  /** How long one prefix may take to deliver the whole archive before the next one is tried. */
  skillsTimeoutMs: number
}

/** The shared fields' schema; `skillsUrls` defaults to GitHub's archive host. */
export const UpstreamSkillsConfig: z<Partial<UpstreamSkillsConfig>, UpstreamSkillsConfig> = z.object({
  skillsDir: z.string().min(1),
  skillsUrls: z.array(z.string().pattern(/^https:\/\/[^\s?#@]+$/)).min(1).default(['https://codeload.github.com']),
  skillsTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
})

/** One plugin's packaged entry skill and the upstream files it indexes. */
export interface UpstreamSkillsOptions {
  /** The skill provider's name, also the directory under `$DSH_HOME/cache` that receives the download. */
  readonly name: string
  /** Absolute path of the packaged entry `SKILL.md`, whose frontmatter gives the skill's name and description. */
  readonly entry: string
  /** The pinned upstream files. */
  readonly set: UpstreamSkillSet
  /** The plugin's `skillsDir`, `skillsUrls`, and `skillsTimeoutMs`. */
  readonly config: UpstreamSkillsConfig
}

/**
 * Register the entry skill's provider and start downloading the upstream files unless they are in place. The download
 * starts at load so that a session without a client also gets the skill; a failure is logged as a warning and waits
 * for `retry()`. Disposing the plugin aborts the download and removes the provider.
 * @param ctx - Context carrying the skill registry and the logger.
 * @param options - the provider name, entry, pinned files, and configured sources.
 * @returns the handle the plugin's view observes and its check retries.
 * @throws when the entry has no skill name or description in its frontmatter, or `skillsDir` is not a directory.
 */
export function registerUpstreamSkills(ctx: Context, options: UpstreamSkillsOptions): UpstreamSkills {
  let skills!: UpstreamSkillProvider
  ctx.skills.registerProvider((control) => {
    skills = new UpstreamSkillProvider(options, control, ctx.logger)
    return skills
  })
  skills.retry()
  return skills
}

/** Lists the entry skill while its upstream files are in place, and owns their download. */
class UpstreamSkillProvider implements SkillProvider, UpstreamSkills {
  readonly name: string
  readonly directory: string
  private readonly candidate: SkillCandidate
  private readonly content: string
  private readonly listeners = new Set<(state: UpstreamSkillsState) => void>()
  private running = false

  constructor(
    private readonly options: UpstreamSkillsOptions,
    private readonly control: SkillProviderControl,
    private readonly logger: Context['logger'],
  ) {
    this.name = options.name
    const { skillsDir } = options.config
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
    if (this.state !== 'failed' || this.options.config.skillsDir !== undefined || signal.aborted) return
    this.running = true
    this.notify()
    void this.install(signal).then(
      () => { this.control.invalidate() },
      (error: unknown) => { if (!signal.aborted) this.logger.warn(`${this.name}: the upstream skills are not available`, error) },
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
    const { set, config } = this.options
    const files = await downloadSkillSet(set, config.skillsUrls, config.skillsTimeoutMs, signal, (message, error) => {
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
function readEntry(options: UpstreamSkillsOptions): { name: string; description: string; content: string } {
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
