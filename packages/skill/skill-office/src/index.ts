/** Bundled Office workflows and filesystem resources for document authoring and operations. */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveKitCli } from '@deepseek-ai/dsh-office-kit/locate'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

const SKILL_NAMES = ['office', 'office-docx', 'office-pptx', 'office-xlsx', 'office-render', 'office-recalculate', 'office-export-pdf'] as const
const PYTHON_SKILLS: readonly string[] = ['office-docx', 'office-pptx', 'office-xlsx', 'office-recalculate']
const KIT_SKILLS: readonly string[] = ['office-render', 'office-recalculate', 'office-export-pdf']

/**
 * Python source for Office scripts: `'workspace-dependencies'` directs the model to the bundled interpreter and libraries
 * returned by `load_workspace_dependencies`; `'user'` directs it to an existing project or user Python.
 */
export type PythonEnvironment = 'workspace-dependencies' | 'user'

const PYTHON_ENVIRONMENT_SECTIONS: Readonly<Record<PythonEnvironment, string>> = {
  'workspace-dependencies': 'Follow an explicit user or applicable AGENTS.md requirement for a Python environment. Otherwise call `load_workspace_dependencies` and run scripts with its Python executable and bundled libraries. Do not install packages or search for a system Python for the default workflow. If the tool is unavailable, use an already configured environment and report a missing dependency only when it prevents the requested operation.',
  user: 'Follow an explicit user or applicable AGENTS.md requirement for a Python environment. Otherwise use the project\'s or user\'s existing Python, such as `python3` or `python` on PATH. Before the first script, check that this Python can import the libraries the workflow needs. If Python or a library is missing, tell the user which packages to install; do not install packages into a global environment without the user\'s agreement.',
}

/** Office skill resources and Python environment. */
export interface Config {
  /** Absolute assets directory containing skill folders; defaults to packaged assets. */
  assetRoot?: string
  /** Standalone Node executable; defaults to the current executable outside Electron. */
  node?: string
  /** Absolute LibreOffice Kit CLI entry; false explicitly disables CLI access, and omission uses the CLI of this package's Kit. */
  cli?: string | false
  /**
   * Absolute directory restricting automatic Kit entry and CLI discovery after realpath and ASAR-unpacked mapping.
   * Omission leaves discovery unrestricted; explicit `cli` bypasses the restriction.
   */
  kitRoot?: string
  /** Python environment named in the Python authoring and verification skills. @default 'workspace-dependencies' */
  pythonEnvironment?: PythonEnvironment
}

/** Configuration after schema defaults apply. */
export interface ResolvedConfig extends Config {
  /** Python environment named in the Python authoring and verification skills. */
  pythonEnvironment: PythonEnvironment
}

/** Validated resource configuration. */
export const Config: z<Config, ResolvedConfig> = z.object({
  assetRoot: z.string().min(1),
  node: z.string().min(1),
  kitRoot: z.string().min(1),
  cli: z.union([z.string().min(1), z.const(false)]),
  pythonEnvironment: z.union([z.const('workspace-dependencies'), z.const('user')]).default('workspace-dependencies'),
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

/**
 * Describe the Kit CLI paths operation skills use.
 * @param config - Configured Node and CLI paths.
 * @param reportMissing - Receives the lookup failure when `cli` is omitted and Kit cannot be resolved.
 * @returns Instructions appended to an operation skill.
 */
function officeRuntime(config: Config, reportMissing: (error: unknown) => void): string {
  const runtime = resolveKitCli({
    ...(config.node === undefined ? {} : { node: config.node }),
    ...(config.cli === undefined ? {} : { cli: config.cli }),
    ...(config.kitRoot === undefined ? {} : { root: config.kitRoot }),
    lookupKitEntry: () => import.meta.resolve('@deepseek-ai/libreoffice-kit'),
  })
  switch (runtime.kind) {
    case 'disabled': return '\n\nLibreOffice Kit is disabled in this deployment.'
    case 'missing':
      reportMissing(runtime.error)
      return '\n\nLibreOffice Kit is not available in this deployment.'
    case 'available': {
      const { node, cli } = runtime
      return `\n\n## Installed LibreOffice Kit\n\nUse these absolute paths for every LibreOffice Kit command. Pass the CLI entry as the first argument to Node.\n\n${JSON.stringify({ libreofficeKit: { node, cli } }, undefined, 2)}`
    }
    /* v8 ignore next -- KitCliResolution is a closed union */
    default: return assertNever(runtime)
  }
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
 * @param config - Resolved configuration; resource paths fall back to the packaged assets, Node, and Kit CLI.
 * @throws When `assetRoot` or `kitRoot` is not absolute.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const assetRoot = config.assetRoot ?? fileURLToPath(new URL('../assets/', import.meta.url))
  if (!isAbsolute(assetRoot)) throw new Error('skill-office: assetRoot must be an absolute directory')
  if (config.kitRoot !== undefined && !isAbsolute(config.kitRoot)) throw new Error('skill-office: kitRoot must be an absolute directory')
  const reportedFailures = new Map<string, string>()
  const reportedKitFailures = new Set<string>()
  function reportMissingKit(error: unknown): void {
    const failure = String(error)
    if (reportedKitFailures.has(failure)) return
    reportedKitFailures.add(failure)
    ctx.logger.warn(`skill-office: LibreOffice Kit is not available: ${failure}`)
  }
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
        + (PYTHON_SKILLS.includes(candidate.name) ? `\n\n## Python environment\n\n${PYTHON_ENVIRONMENT_SECTIONS[config.pythonEnvironment]}` : '')
        + (KIT_SKILLS.includes(candidate.name) ? officeRuntime(config, reportMissingKit) : '')
      return { ...summary, content }
    },
  }))
}
