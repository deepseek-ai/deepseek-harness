/**
 * In-memory fixture workspaces for `type-model.spec.ts`.
 *
 * The analyzer reads a workspace through `existsSync`, `readFileSync`, `realpathSync`, and `writeFileSync` from
 * `node:fs`, and through `ts.sys`. A spec mocks `node:fs` with {@link memoryFileSystem} and calls
 * {@link useMemoryWorkspaces}; paths under {@link MEMORY_ROOT} then live in this module's maps, and every other path
 * reaches the real file system. Fixture copies, case edits, write-mode annotations, tsconfig expansion, and TypeScript
 * module resolution inside a workspace never touch the disk.
 *
 * Each workspace mounts minimal `zod` and `@types/node` declaration stubs at its own `node_modules`, so analysis
 * resolves neither the real packages nor anything outside the workspace except the TypeScript default libraries.
 *
 * This module must not import `node:fs`: the mock factory imports it while `node:fs` is being mocked.
 */

import { Buffer } from 'node:buffer'
import type * as NodeFileSystem from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { afterAll, afterEach, beforeAll } from 'vitest'

type FileSystem = typeof NodeFileSystem

interface FileSystemEntries {
  readonly files: readonly string[]
  readonly directories: readonly string[]
}

type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => FileSystemEntries,
  realpath: (path: string) => string,
) => string[]

/** TypeScript's include/exclude matcher, the one `ts.sys.readDirectory` applies to real directory listings. */
const { matchFiles } = ts as typeof ts & { readonly matchFiles: MatchFiles | undefined }

/** Absolute directory that holds every in-memory workspace; it does not exist on disk. */
export const MEMORY_ROOT = resolve('/dsh-typert-memory')

/** The unmodified fixture workspace on disk, read once per spec file. */
export const fixtureRoot = resolve(import.meta.dirname, 'fixtures/type-model')

/** Declaration stubs for the fixture's external packages, mounted under each workspace's `node_modules`. */
const DEPENDENCY_STUBS: Readonly<Record<string, string>> = {
  'zod/package.json': `${JSON.stringify({ name: 'zod', version: '0.0.0', type: 'module', types: './index.d.ts' })}\n`,
  'zod/index.d.ts': 'export interface ZodType<Output = unknown> { readonly _output: Output }\n',
  '@types/node/package.json': `${JSON.stringify({ name: '@types/node', version: '0.0.0', types: './index.d.ts' })}\n`,
  '@types/node/index.d.ts': 'declare namespace NodeJS { interface Process { readonly pid: number } }\n',
}

const memoryRootKey = key(MEMORY_ROOT)
const files = new Map<string, string>()
const directories = new Set<string>()
const readOnlyRoots = new Set<string>()
const caseRoots: string[] = []
let realFileSystem: FileSystem | undefined
let fixtureFiles: ReadonlyMap<string, string> | undefined
let pristineRoot: string | undefined
let sequence = 0

function key(path: string): string {
  return resolve(path).replaceAll('\\', '/')
}

function isMemoryPath(path: NodeFileSystem.PathOrFileDescriptor): path is string {
  if (typeof path !== 'string') return false
  const normalized = key(path)
  return normalized === memoryRootKey || normalized.startsWith(`${memoryRootKey}/`)
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`)
}

function fileSystemError(code: 'EEXIST' | 'EISDIR' | 'ENOENT' | 'EROFS', syscall: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path })
}

function addDirectory(path: string): void {
  let current = key(path)
  while (!directories.has(current)) {
    directories.add(current)
    if (current === memoryRootKey) return
    current = key(dirname(current))
  }
}

function setFile(path: string, content: string): void {
  addDirectory(dirname(path))
  files.set(key(path), content)
}

function assertWritable(target: string, syscall: string, path: string): void {
  for (const root of readOnlyRoots) {
    if (isWithin(target, root)) throw fileSystemError('EROFS', syscall, path)
  }
}

function writeMemoryFile(path: string, content: string): void {
  const target = key(path)
  assertWritable(target, 'open', path)
  if (directories.has(target)) throw fileSystemError('EISDIR', 'open', path)
  if (!directories.has(key(dirname(path)))) throw fileSystemError('ENOENT', 'open', path)
  files.set(target, content)
}

function makeMemoryDirectory(path: string, recursive: boolean): string | undefined {
  const target = key(path)
  assertWritable(target, 'mkdir', path)
  if (directories.has(target)) {
    if (recursive) return undefined
    throw fileSystemError('EEXIST', 'mkdir', path)
  }
  if (files.has(target)) throw fileSystemError('EEXIST', 'mkdir', path)
  if (!recursive && !directories.has(key(dirname(path)))) throw fileSystemError('ENOENT', 'mkdir', path)
  let first = target
  for (let parent = key(dirname(first)); !directories.has(parent); parent = key(dirname(parent))) first = parent
  addDirectory(target)
  return recursive ? resolve(first) : undefined
}

function memoryEntries(path: string): FileSystemEntries {
  const prefix = `${key(path)}/`
  const children = (entries: Iterable<string>): string[] => [...entries]
    .flatMap(entry => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/') ? [entry.slice(prefix.length)] : [])
    .sort()
  return { files: children(files.keys()), directories: children(directories) }
}

function removeTree(root: string): void {
  for (const file of [...files.keys()]) if (isWithin(file, root)) files.delete(file)
  for (const directory of [...directories]) if (isWithin(directory, root)) directories.delete(directory)
}

/**
 * Build the `node:fs` mock for `vi.mock('node:fs', ...)`. Memory paths are served from this module; every other
 * path, and every other `node:fs` export, is the real implementation.
 * @param real - the actual `node:fs` module from `importOriginal`.
 * @returns the mocked module namespace, including its `default` export.
 */
export function memoryFileSystem(real: FileSystem): Record<string, unknown> {
  realFileSystem = real
  const memory = {
    existsSync(path: NodeFileSystem.PathLike): boolean {
      if (!isMemoryPath(path)) return real.existsSync(path)
      return files.has(key(path)) || directories.has(key(path))
    },
    readFileSync(
      path: NodeFileSystem.PathOrFileDescriptor,
      options?: BufferEncoding | { readonly encoding?: BufferEncoding | null; readonly flag?: string } | null,
    ): string | Buffer {
      if (!isMemoryPath(path)) return real.readFileSync(path, options)
      const content = files.get(key(path))
      if (content === undefined) throw fileSystemError(directories.has(key(path)) ? 'EISDIR' : 'ENOENT', 'open', path)
      const encoding = typeof options === 'string' ? options : options?.encoding
      return encoding === undefined || encoding === null ? Buffer.from(content) : Buffer.from(content).toString(encoding)
    },
    writeFileSync(
      path: NodeFileSystem.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: NodeFileSystem.WriteFileOptions,
    ): void {
      if (!isMemoryPath(path)) {
        real.writeFileSync(path, data, options)
        return
      }
      writeMemoryFile(path, typeof data === 'string'
        ? data
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'))
    },
    mkdirSync(
      path: NodeFileSystem.PathLike,
      options?: NodeFileSystem.Mode | NodeFileSystem.MakeDirectoryOptions | null,
    ): string | undefined {
      if (!isMemoryPath(path)) return real.mkdirSync(path, options)
      return makeMemoryDirectory(path, typeof options === 'object' && options?.recursive === true)
    },
    realpathSync(path: NodeFileSystem.PathLike, options?: NodeFileSystem.EncodingOption): string {
      if (!isMemoryPath(path)) return real.realpathSync(path, options)
      if (!files.has(key(path)) && !directories.has(key(path))) throw fileSystemError('ENOENT', 'realpath', path)
      return resolve(path)
    },
  }
  return { ...real, ...memory, default: { ...real, ...memory } }
}

function installMemorySystem(): () => void {
  if (matchFiles === undefined) throw new Error('typescript no longer exposes matchFiles for in-memory readDirectory')
  const match = matchFiles
  const system = ts.sys
  /* oxlint-disable typescript/unbound-method -- Each saved method is invoked with `.call(system)` or restored onto `system`. */
  const original = {
    fileExists: system.fileExists,
    directoryExists: system.directoryExists,
    getDirectories: system.getDirectories,
    readDirectory: system.readDirectory,
    readFile: system.readFile,
    realpath: system.realpath,
  }
  /* oxlint-enable typescript/unbound-method */
  // Every checkProject program re-reads the default libraries from the installed typescript package, which is immutable.
  const libraryRoot = key(dirname(ts.getDefaultLibFilePath({})))
  const libraryFiles = new Map<string, string | undefined>()
  system.fileExists = path => isMemoryPath(path) ? files.has(key(path)) : original.fileExists.call(system, path)
  system.directoryExists = path => isMemoryPath(path)
    ? directories.has(key(path))
    : original.directoryExists.call(system, path)
  system.getDirectories = path => isMemoryPath(path)
    ? [...memoryEntries(path).directories]
    : original.getDirectories.call(system, path)
  system.readDirectory = (path, extensions, excludes, includes, depth) => isMemoryPath(path)
    ? match(path, extensions, excludes, includes, system.useCaseSensitiveFileNames, process.cwd(), depth, memoryEntries, entry => entry)
    : original.readDirectory.call(system, path, extensions, excludes, includes, depth)
  system.readFile = (path, encoding) => {
    if (isMemoryPath(path)) return files.get(key(path))
    if (encoding !== undefined || !isWithin(key(path), libraryRoot)) return original.readFile.call(system, path, encoding)
    if (!libraryFiles.has(path)) libraryFiles.set(path, original.readFile.call(system, path))
    return libraryFiles.get(path)
  }
  const { realpath } = original
  if (realpath !== undefined) system.realpath = path => isMemoryPath(path) ? path : realpath.call(system, path)
  return () => { Object.assign(system, original) }
}

/**
 * Register the spec-file hooks that own memory workspaces: `ts.sys` routes memory paths from `beforeAll` until
 * `afterAll`, and the workspaces a case creates are dropped after it.
 */
export function useMemoryWorkspaces(): void {
  let restore: (() => void) | undefined
  beforeAll(() => { restore = installMemorySystem() })
  afterEach(() => {
    for (const root of caseRoots.splice(0)) removeTree(root)
  })
  afterAll(() => {
    restore?.()
    files.clear()
    directories.clear()
    readOnlyRoots.clear()
    pristineRoot = undefined
  })
}

function fixtureSources(): ReadonlyMap<string, string> {
  if (fixtureFiles !== undefined) return fixtureFiles
  const real = realFileSystem
  if (real === undefined) throw new Error('mock node:fs with memoryFileSystem before reading the fixture')
  const collected = new Map<string, string>()
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of real.readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = join(relativeDirectory, entry.name)
      if (entry.isDirectory()) visit(path, relativePath)
      else collected.set(relativePath, real.readFileSync(path, 'utf8'))
    }
  }
  visit(fixtureRoot, '')
  fixtureFiles = collected
  return collected
}

function mountDependencyStubs(root: string): void {
  for (const [path, content] of Object.entries(DEPENDENCY_STUBS)) setFile(join(root, 'node_modules', path), content)
}

function mountFixture(root: string): void {
  for (const [path, content] of fixtureSources()) setFile(join(root, path), content)
  mountDependencyStubs(root)
}

/**
 * Create an empty memory workspace owned by the current case.
 * @param prefix - directory-name prefix that identifies the owning case.
 * @param options - `dependencies` mounts the `zod` and `@types/node` stubs under its `node_modules`.
 * @returns the absolute workspace root.
 */
export function emptyWorkspace(prefix: string, options: { readonly dependencies?: boolean } = {}): string {
  sequence += 1
  const root = join(MEMORY_ROOT, `${prefix}${String(sequence)}`)
  addDirectory(root)
  caseRoots.push(key(root))
  if (options.dependencies === true) mountDependencyStubs(root)
  return root
}

/**
 * Create an editable memory copy of the fixture workspace owned by the current case.
 * @param prefix - directory-name prefix that identifies the owning case.
 * @returns the absolute workspace root.
 */
export function copyFixture(prefix: string): string {
  const root = emptyWorkspace(prefix)
  mountFixture(root)
  return root
}

/**
 * Return the read-only memory copy of the fixture shared by every case of the spec file; writes under it throw
 * `EROFS`.
 * @returns the absolute workspace root.
 */
export function pristineFixture(): string {
  if (pristineRoot !== undefined) return pristineRoot
  const root = join(MEMORY_ROOT, 'pristine')
  addDirectory(root)
  mountFixture(root)
  readOnlyRoots.add(key(root))
  pristineRoot = root
  return root
}
