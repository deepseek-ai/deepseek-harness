/** Bundled Office workflows and filesystem resources for document authoring and operations. */

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

const SKILL_NAMES = ['office', 'office-docx', 'office-pptx', 'office-xlsx', 'office-render', 'office-recalculate', 'office-export-pdf'] as const

/** Office skill resource location. */
export interface Config {
  /** Absolute assets directory containing skill folders; defaults to packaged assets. */
  assetRoot?: string
  /** Standalone Node executable; defaults to the current executable outside Electron and SEA. */
  node?: string
  /** Absolute LibreOffice Kit CLI entry; false explicitly disables CLI access. */
  cli?: string | false
}

/** Validated resource configuration. */
export const Config: z<Config> = z.object({
  assetRoot: z.string().min(1),
  node: z.string().min(1),
  cli: z.union([z.string().min(1), z.const(false)]),
})

/** Cordis plugin identity. */
export const name = 'skill-office'
/** Registry used by the bundled provider. */
export const inject = ['skills']

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-office: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description : undefined
  if (typeof description !== 'string' || description.length === 0) throw new Error(`skill-office: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

function officeRuntime(config: Config): string {
  if (config.cli === false) return '\n\nLibreOffice Kit is disabled in this deployment.'
  if (config.node === undefined && (isSea() || process.versions.electron !== undefined)) {
    throw new Error('skill-office: packaged applications must supply a standalone Node executable')
  }
  const node = config.node ?? process.execPath
  let cli = config.cli
  if (cli === undefined) {
    const manifestPath = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
    cli = join(dirname(manifestPath), 'lib', 'cli.js')
  }
  for (const path of [node, cli]) {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error(`skill-office: expected an absolute executable file: ${path}`)
  }
  return `\n\n## Installed LibreOffice Kit\n\nUse these absolute paths for every LibreOffice Kit command. Pass the CLI entry as the first argument to Node.\n\n${JSON.stringify({ libreofficeKit: { node, cli } }, undefined, 2)}`
}

/** Outcome of reading one skill file: parsed metadata, or a failure that may clear on a later read. */
type SkillRead =
  | { readonly kind: 'loaded'; readonly description: string; readonly content: string }
  | { readonly kind: 'failed'; readonly error: unknown; readonly persistent: boolean }

/** Missing paths persist until the file appears; other read errors, such as locks, may clear. */
function persistentReadFailure(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Register Office skills with resources readable by the script interpreter.
 * Skill files are read during catalog discovery and loading, and each distinct failure is reported once. A missing
 * or invalid skill is omitted from a complete catalog, and its failed load returns `undefined` and invalidates the
 * catalog. Any other read error leaves discovery incomplete, so the registry retries it, and rejects a load.
 * @param ctx - Context carrying the skill registry.
 * @param config - Optional external assets directory for packaged applications.
 * @throws When `assetRoot` is not absolute.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? fileURLToPath(new URL('../assets/', import.meta.url))
  if (!isAbsolute(assetRoot)) throw new Error('skill-office: assetRoot must be an absolute directory')
  const reportedFailures = new Map<string, string>()
  async function readSkill(skillName: string, signal: AbortSignal | undefined): Promise<SkillRead> {
    const path = join(assetRoot, skillName, 'SKILL.md')
    let raw: string
    try {
      raw = await readFile(path, { encoding: 'utf8', signal })
    } catch (error) {
      if (signal?.aborted === true) throw error
      return failed(skillName, error, persistentReadFailure(error))
    }
    let skill: { description: string; content: string }
    try {
      skill = parseSkill(raw, path)
    } catch (error) {
      // Invalid metadata, including YAML errors that carry their own codes, persists until the file changes.
      return failed(skillName, error, true)
    }
    reportedFailures.delete(skillName)
    return { kind: 'loaded', ...skill }
  }
  function failed(skillName: string, error: unknown, persistent: boolean): SkillRead {
    const failure = String(error)
    if (reportedFailures.get(skillName) !== failure) {
      reportedFailures.set(skillName, failure)
      ctx.logger.warn(`skill-office: skill "${skillName}" is unavailable: ${failure}`)
    }
    return { kind: 'failed', error, persistent }
  }
  ctx.skills.registerProvider(control => ({
    name: 'dsh-office',
    async list(options) {
      const reads = await Promise.all(SKILL_NAMES.map(async skillName => ({ skillName, read: await readSkill(skillName, options.signal) })))
      const candidates: SkillCandidate[] = []
      for (const { skillName, read } of reads) {
        if (read.kind === 'failed') continue
        const directory = join(assetRoot, skillName)
        candidates.push({
          name: skillName, description: read.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'dsh-office', source: 'bundled', rank: BUNDLED_SKILL_RANK,
          resourceBase: { kind: 'directory', path: directory.split(sep).join('/') }, locator: join(directory, 'SKILL.md'),
        })
      }
      return { candidates, complete: reads.every(({ read }) => read.kind === 'loaded' || read.persistent) }
    },
    async get(candidate, options) {
      const { rank: _rank, locator: _locator, ...summary } = candidate
      const read = await readSkill(candidate.name, options.signal)
      if (read.kind === 'failed') {
        if (!read.persistent) throw read.error
        control.invalidate()
        return undefined
      }
      const content = read.content
        + (['office-render', 'office-recalculate', 'office-export-pdf'].includes(candidate.name) ? officeRuntime(config) : '')
      return { ...summary, content }
    },
  }))
}
