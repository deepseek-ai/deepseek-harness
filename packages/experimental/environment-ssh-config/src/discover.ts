/** Discover concrete Host aliases without evaluating Match exec or opening network connections. */
import { glob, lstat, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import SSHConfig, { LineType } from 'ssh-config'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'

/** Inputs and outputs of one {@link discoverHosts} beyond its aliases. */
export interface DiscoveryOptions {
  /** Treat an absent `file` as declaring no aliases, as OpenSSH does for the default user configuration. */
  readonly optional: boolean
  /**
   * Receives every existing directory whose entries can change the result: the directories of the files read,
   * through the paths that reached them and their real paths, and the directories where a missing file or a new
   * Include match can appear. Directories found before a failure are added too.
   */
  readonly directories: Set<string>
}

/**
 * Read concrete aliases from a user SSH configuration and its Include files.
 * @param file - configuration file, passed unchanged to OpenSSH by the provider.
 * @param options - absent-file handling and the directories to watch for changes.
 * @returns distinct non-pattern Host aliases in declaration order.
 */
export async function discoverHosts(file: string, options: DiscoveryOptions): Promise<readonly string[]> {
  const { directories } = options
  const aliases = new Set<string>()
  const visited = new Set<string>()
  const active = new Set<string>()
  async function visit(path: string): Promise<void> {
    directories.add(await existingDirectory(dirname(path)))
    const canonical = await realpath(path)
    directories.add(dirname(canonical))
    if (active.has(canonical)) throw new Error(`SSH configuration Include cycle: ${canonical}`)
    if (visited.has(canonical)) return
    active.add(canonical)
    const config = parse(await readFile(canonical, 'utf8'), canonical)
    async function walk(lines: SSHConfig, includeAllHosts: boolean): Promise<void> {
      for (const line of lines) {
        if (line.type !== LineType.DIRECTIVE) continue
        const words = typeof line.value === 'string' ? [line.value] : line.value.map(value => value.val)
        const directive = line.param.toLowerCase()
        if (directive === 'host') {
          for (const host of words) {
            if (host !== '' && !/[!*?\[\]]/.test(host)) aliases.add(host)
          }
        }
        if (directive === 'include' && includeAllHosts) {
          for (const word of words) {
            const expanded = expandHomePath(word)
            const pattern = isAbsolute(expanded) ? expanded : resolve(homedir(), '.ssh', expanded)
            await addPatternDirectories(pattern, directories)
            const matches: string[] = []
            for await (const included of glob(pattern)) matches.push(included)
            for (const included of matches.sort()) await visit(included)
          }
        }
        // Conditional Includes may define aliases that do not activate their containing block.
        if ('config' in line) await walk(line.config, directive === 'host' && words.length === 1 && words[0] === '*')
      }
    }
    await walk(config, true)
    active.delete(canonical)
    visited.add(canonical)
  }
  if (options.optional && !await present(file)) {
    directories.add(await existingDirectory(dirname(file)))
    return []
  }
  await visit(file)
  return [...aliases]
}

function parse(text: string, file: string): SSHConfig {
  try {
    return SSHConfig.parse(text)
  } catch (error) {
    throw new Error(`Cannot parse SSH configuration ${file}: ${(error as Error).message}`, { cause: error })
  }
}

/** Add the directories whose entries decide which files `pattern` matches, including wildcard directory segments. */
async function addPatternDirectories(pattern: string, directories: Set<string>): Promise<void> {
  const parent = dirname(pattern)
  if (!/[*?[{]/.test(parent)) {
    directories.add(await existingDirectory(parent))
    return
  }
  for await (const entry of glob(parent, { withFileTypes: true })) {
    if (entry.isDirectory()) directories.add(join(entry.parentPath, entry.name))
  }
  await addPatternDirectories(parent, directories)
}

/**
 * The nearest existing directory at or above `path`; a missing or non-directory entry defers to its parent. A file
 * system root that does not exist either, such as the root of an absent drive, is returned as it is.
 */
async function existingDirectory(path: string): Promise<string> {
  for (let current = path; ; current = dirname(current)) {
    try {
      if ((await stat(current)).isDirectory()) return current
    } catch (error) {
      if (!missing(error)) throw error
    }
    if (dirname(current) === current) return current
  }
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function missing(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException
  return code === 'ENOENT' || code === 'ENOTDIR'
}
