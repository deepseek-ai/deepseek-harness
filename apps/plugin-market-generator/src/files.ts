/** Atomic file writes shared by the cache and the output, and the read-only file trees packages are read from. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'

/**
 * Write `contents` through a temporary sibling and a rename, leaving the file untouched when it already holds them.
 * A reader never sees a partially written file.
 * @param file - destination path.
 * @param contents - complete file contents.
 * @returns whether the file changed.
 */
export function writeIfChanged(file: string, contents: Uint8Array | string): boolean {
  const bytes = Buffer.from(contents)
  if (existsSync(file) && readFileSync(file).equals(bytes)) return false
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  writeFileSync(temporary, bytes)
  renameSync(temporary, file)
  return true
}

/**
 * Read a JSON file written by {@link writeIfChanged}.
 * @param file - path to read.
 * @returns the parsed value, or undefined when the file is absent or is not valid JSON.
 */
export function readJsonFile(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (_malformed) {
    // A file from an older or interrupted generator is treated as absent and rebuilt.
    return undefined
  }
}

/** One regular file of a {@link PackageFiles} tree. */
export interface FileEntry {
  readonly size: number
  readonly read: () => Promise<Uint8Array>
}

/**
 * The regular files of an npm tarball or a Git tree, read without a file system. Paths are normalized POSIX paths
 * relative to the tree root `''`; symbolic links, submodules, and directories without files do not exist.
 */
/** Largest manifest, locale, or workspace file read, in bytes. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024

export class PackageFiles {
  readonly #files: ReadonlyMap<string, FileEntry>
  /** Names of the directories and files directly inside each directory. */
  readonly #children = new Map<string, { readonly directories: Set<string>; readonly files: string[] }>()

  /** @param files - regular files by normalized relative path. */
  constructor(files: ReadonlyMap<string, FileEntry>) {
    this.#files = files
    for (const path of files.keys()) {
      const segments = path.split('/')
      segments.forEach((name, depth) => {
        const dir = segments.slice(0, depth).join('/')
        let children = this.#children.get(dir)
        if (children === undefined) this.#children.set(dir, children = { directories: new Set(), files: [] })
        if (depth === segments.length - 1) children.files.push(name)
        else children.directories.add(name)
      })
    }
  }

  /**
   * Resolve a relative reference inside the tree.
   * @param base - directory the reference is relative to.
   * @param reference - relative path, possibly starting with `./`.
   * @returns the normalized path, or undefined when the reference is absolute or leaves the tree.
   */
  static resolve(base: string, reference: string): string | undefined {
    if (posix.isAbsolute(reference)) return undefined
    const path = posix.normalize(posix.join(base, reference)).replace(/\/$/u, '')
    if (path === '..' || path.startsWith('../')) return undefined
    return path === '.' ? '' : path
  }

  /**
   * @param path - normalized file path.
   * @returns the regular file with that path, or undefined.
   */
  file(path: string): FileEntry | undefined {
    return this.#files.get(path)
  }

  /**
   * Read a text file such as a manifest or locale file.
   * @param path - normalized file path.
   * @returns the file contents, or undefined when no regular file has that path.
   * @throws when the file exceeds {@link MAX_TEXT_FILE_BYTES}.
   */
  async read(path: string): Promise<Uint8Array | undefined> {
    const file = this.#files.get(path)
    if (file !== undefined && file.size > MAX_TEXT_FILE_BYTES) throw new Error(`${path} exceeds ${MAX_TEXT_FILE_BYTES} bytes`)
    return await file?.read()
  }

  /**
   * @param dir - normalized directory path.
   * @returns the names of the directories directly inside `dir`, sorted.
   */
  directories(dir: string): string[] {
    return [...this.#children.get(dir)?.directories ?? []].sort()
  }

  /**
   * @param dir - normalized directory path.
   * @returns the names of the regular files directly inside `dir`, sorted.
   */
  fileNames(dir: string): string[] {
    return [...this.#children.get(dir)?.files ?? []].sort()
  }

  /**
   * @param dir - normalized directory path.
   * @returns the files below `dir`, with paths relative to it.
   */
  within(dir: string): PackageFiles {
    if (dir === '') return this
    const prefix = `${dir}/`
    const inside = [...this.#files].flatMap(([path, entry]) => path.startsWith(prefix) ? [[path.slice(prefix.length), entry] as const] : [])
    return new PackageFiles(new Map(inside))
  }
}
