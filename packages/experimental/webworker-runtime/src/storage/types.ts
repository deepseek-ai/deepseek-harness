/**
 * Filesystem interfaces shared by every VFS backend. The shipped implementation
 * is in memory; browser persistence hydrates it and consumes its committed
 * mutation stream. Errors carry Node's `code` values because roster plugins
 * branch on them (`ENOENT` for optional files, `EACCES` for read-only trees).
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/types
 */

/** Encodings the VFS accepts where Node accepts any `BufferEncoding`. */
export type VfsEncoding = 'utf8' | 'utf-8'

/** Read options accepted by both the sync and promise faces. */
export type VfsReadOptions = VfsEncoding | { encoding?: VfsEncoding | null } | null | undefined

/** Node-compatible error with a `code`, as roster plugins expect. */
export interface VfsError extends Error {
  code: string
  path: string
  syscall: string
}

/** Subset of `fs.Stats` the roster reads. */
export interface VfsStats {
  readonly size: number
  /** Stable file identity across rename and hard links; recreation receives another value. */
  readonly ino: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly atimeMs: number
  readonly birthtimeMs: number
  readonly mtime: Date
  readonly mode: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
}

/**
 * Stats as Node returns them under `{ bigint: true }`.
 *
 * The filesystem service (`dsh-fs-local`) stats every target this way and then
 * does BigInt arithmetic on `mode` and builds its version token from
 * `dev:ino:size:mtimeNs:ctimeNs`, so these fields are load-bearing rather than
 * decorative: a number-valued `mode` here fails the whole read as a type error,
 * and a constant `ino`/`mtimeNs` would make the service's stale-write guard
 * unable to tell two revisions apart.
 */
export interface VfsBigIntStats {
  readonly size: bigint
  readonly mode: bigint
  /** One virtual device holds the whole image. */
  readonly dev: bigint
  /** File identity retained across rename and hard links; recreation gets a new one. */
  readonly ino: bigint
  readonly nlink: bigint
  readonly mtimeMs: bigint
  readonly mtimeNs: bigint
  readonly ctimeMs: bigint
  readonly ctimeNs: bigint
  readonly atimeMs: bigint
  readonly atimeNs: bigint
  readonly birthtimeMs: bigint
  readonly birthtimeNs: bigint
  readonly mtime: Date
  readonly ctime: Date
  readonly atime: Date
  readonly birthtime: Date
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
}

/** Stat option Node reads; `bigint` selects {@link VfsBigIntStats}. */
export interface VfsStatOptions {
  readonly bigint?: boolean
}

/** Write options the roster passes; `flag` decides create and truncate behavior. */
export interface VfsWriteOptions {
  readonly encoding?: VfsEncoding | null
  readonly mode?: number
  readonly flag?: string
}

/** Explicit metadata for image or durable-store hydration. */
export interface VfsSeedOptions {
  readonly mode?: number
  readonly mtimeMs?: number
}

/** Directory entry as `readdir` with `withFileTypes` reports it. */
export interface VfsDirent {
  readonly name: string
  readonly parentPath: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** Directory handle returned by `opendir`; consumers only enumerate and close. */
export interface VfsDir {
  readonly path: string
  close(): Promise<void>
  read(): Promise<{ name: string } | null>
  [Symbol.asyncIterator](): AsyncGenerator<{ name: string; isFile(): boolean; isDirectory(): boolean }>
}

/** File handle returned by `open`; the roster writes, syncs, and closes. */
export interface VfsFileHandle {
  write(data: string | Uint8Array): Promise<{ bytesWritten: number }>
  writeFile(data: string | Uint8Array): Promise<void>
  readFile(options?: VfsReadOptions): Promise<string | Uint8Array>
  truncate(length?: number): Promise<void>
  chmod(mode: number): Promise<void>
  stat(options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats>
  sync(): Promise<void>
  datasync(): Promise<void>
  close(): Promise<void>
}

/** Open-file identity used by synchronous Node-style descriptors. */
export interface VfsOpenFile {
  /** Whether reads are allowed by the flags used at open time. */
  readonly readable: boolean
  /** Whether writes and truncation are allowed by the flags used at open time. */
  readonly writable: boolean
  /** Whether each write targets the current end of the opened file. */
  readonly append: boolean
  /**
   * Read bytes from the opened file identity.
   * @param position - Absolute byte offset.
   * @param length - Maximum byte count.
   * @returns A view of the available bytes.
   */
  read(position: number, length: number): Uint8Array
  /**
   * Write bytes to the opened file identity.
   * @param position - Absolute byte offset, ignored for append descriptors.
   * @param data - Bytes to write.
   * @returns Number of bytes written.
   */
  write(position: number, data: Uint8Array): number
  /**
   * Resize the opened file, zero-filling growth.
   * @param length - Target byte length.
   */
  truncate(length: number): void
  /** Change permission bits on the opened file identity. */
  chmod(mode: number): void
  /**
   * Read metadata from the opened file identity.
   * @returns Current file metadata, including after rename or unlink.
   */
  stat(): VfsStats
  /**
   * Read BigInt metadata from the opened file identity.
   * @returns Current file metadata, including device and inode identity.
   */
  statBigInt(): VfsBigIntStats
}

/**
 * One completed change to the authoritative in-memory filesystem.
 *
 * A durable mirror receives the post-write bytes, virtual permission bits, and optional append offset;
 * live watchers use `entryChanged` to distinguish directory-entry replacement
 * from content writes. Rename is represented as source removal plus complete
 * destination mkdir/write records, so a sink never receives a path without the
 * state needed to materialize it.
 */
export type VfsMutation =
  | {
    readonly kind: 'write'
    readonly path: string
    readonly bytes: Uint8Array
    readonly mode: number
    readonly entryChanged: boolean
    readonly appendedFrom?: number
  }
  | { readonly kind: 'mkdir'; readonly path: string; readonly mode: number }
  | { readonly kind: 'remove'; readonly path: string }
  | { readonly kind: 'chmod'; readonly path: string; readonly mode: number }

/** Receives one committed VFS mutation. */
export type VfsMutationListener = (mutation: VfsMutation) => void

/** Durable observer attached to the synchronous VFS. */
export interface VfsMutationSink {
  /**
   * Record one completed mutation without delaying its caller.
   * @param mutation - Post-commit state to mirror.
   */
  record(mutation: VfsMutation): void
  /**
   * Settle all previously recorded mutations.
   * Implementations report persistence failures and stop mirroring rather than
   * rejecting, because the in-memory mutation has already committed.
   * @returns A promise that resolves when the sink has no pending work.
   */
  flush(): Promise<void>
}

/** Synchronous filesystem used by the worker's Node compatibility modules. */
export interface Vfs {
  readonly promises: {
    readFile(path: string, options?: VfsReadOptions): Promise<string | Uint8Array>
    writeFile(path: string, data: string | Uint8Array, options?: VfsWriteOptions): Promise<void>
    appendFile(path: string, data: string | Uint8Array): Promise<void>
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>
    readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] & VfsDirent[]>
    stat(path: string, options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats>
    lstat(path: string, options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats>
    realpath(path: string): Promise<string>
    rename(from: string, to: string): Promise<void>
    unlink(path: string): Promise<void>
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
    mkdtemp(prefix: string): Promise<string>
    link(existing: string, next: string): Promise<void>
    truncate(path: string, length?: number): Promise<void>
    chmod(path: string, mode: number): Promise<void>
    opendir(path: string): Promise<VfsDir>
    open(path: string, flags?: string, mode?: number): Promise<VfsFileHandle>
    access(path: string): Promise<void>
  }
  readFileSync(path: string, options?: VfsReadOptions): string | Uint8Array
  existsSync(path: string): boolean
  statSync(path: string, options?: VfsStatOptions): VfsStats | VfsBigIntStats
  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] & VfsDirent[]
  realpathSync(path: string): string
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined
  writeFileSync(path: string, data: string | Uint8Array, options?: VfsWriteOptions): void
  appendFileSync(path: string, data: string | Uint8Array): void
  renameSync(from: string, to: string): void
  linkSync(existing: string, next: string): void
  truncateSync(path: string, length?: number): void
  chmodSync(path: string, mode: number): void
  unlinkSync(path: string): void
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  mkdtempSync(prefix: string): string
  /** Open and retain one file identity until its Node descriptor closes. */
  openFileSync(path: string, flags?: string, mode?: number): VfsOpenFile
  seed(path: string, data: string | Uint8Array, options?: VfsSeedOptions): void
  seedDirectory(path: string, options?: VfsSeedOptions): void
  usage(): { files: number; directories: number; bytes: number }
  /** Register one observer and return its synchronous disposer. */
  subscribe(listener: VfsMutationListener): () => void
  /** Settle the attached durable mutation sink, if any. */
  flush(): Promise<void>
}
