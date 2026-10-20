/**
 * Cached partial clones for plugin detail documents of repositories that need the user's Git credentials or have no
 * anonymous single-file API. Each repository is a bare repository fetched with depth 1 and without file contents; Git
 * downloads a file's contents only when it is read. No working tree is created, so no checkout filter, hook, LFS
 * download, or symbolic link takes effect. A repository whose operation fails or is cancelled is deleted, so an
 * interrupted command never leaves a damaged clone behind.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { DetailFailure, readmeName, type FoundFile } from '@deepseek-ai/dsh-plugin-detail'

/**
 * Git deadlines one operation's lock waits for: an operation runs at most a fetch and a file read that contact the
 * remote, each bounded by the deadline, plus short local commands.
 */
const OPERATION_COMMANDS = 4

/** Limits, location, and transports of the clone cache. */
export interface RepositoryCacheOptions {
  /** Directory holding one bare repository per repository URL. */
  readonly dir: string
  /** Largest amount one command adds to a repository; a command that adds more is stopped and the repository deleted. */
  readonly maxRepositoryBytes: number
  /** Largest total size; least recently used repositories are deleted after a fetch until the cache fits. */
  readonly maxCacheBytes: number
  /** Deadline of one Git command and of one anonymous accessibility check. */
  readonly timeoutMs: number
  /** How long a repository's default-branch commit and its anonymous accessibility are reused. */
  readonly ttlMs: number
  /** Git transports Git may use, such as `https` and `ssh`; `url.<base>.insteadOf` in the user's configuration still applies. */
  readonly transports: readonly string[]
  /** Disposal of the owning service. */
  readonly lifetime: AbortSignal
  /** Interval between size checks of a repository while Git fetches into it. */
  readonly sizePollMs: number
}

/** Output that names a connection failure or a timeout rather than a refusal by the server. */
const NETWORK_FAILURE = new RegExp([
  'Could not resolve host', 'Failed to connect', 'Connection (?:refused|reset)', 'timed out', 'Network is unreachable', 'SSL', 'TLS',
].join('|'), 'iu')

/** One Git command's outcome. */
interface GitResult {
  readonly stdout: Buffer
  readonly failed: boolean
  /** The output exceeded the command's buffer. */
  readonly overflowed: boolean
  /** How the command ended, such as its exit code or the deadline it passed, followed by its error output. */
  readonly diagnostic: string
}

/** A file over the size its read accepts; the clone itself stays usable. */
class FileTooLarge extends DetailFailure {
  /** @param path - the file. @param maxBytes - the accepted size. */
  constructor(path: string, maxBytes: number) {
    super('too-large', `${path} exceeds ${String(maxBytes)} bytes`)
  }
}

/** The failure of a Git command that contacts the remote: `network` for a timeout or a connection failure, otherwise `denied`. */
function remoteFailureOf(result: GitResult, label: string): DetailFailure {
  return new DetailFailure(NETWORK_FAILURE.test(result.diagnostic) ? 'network' : 'denied', `${label}: ${result.diagnostic}`)
}

/** A value reused until it expires. */
interface Expiring<T> {
  readonly value: T
  readonly expiresAt: number
}

async function sizeOf(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size
  }
  return total
}

/** Staging directories that an initialization in progress owns; an older one was left by a stopped process. */
const STAGING_PREFIX = '.init-'

/**
 * The environment of every Git command: the scrubbed parent environment without Git overrides such as `GIT_DIR`, which a
 * hook that launched DSH can leave, and without prompts or LFS downloads.
 */
function gitEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(scrubbedParentEnv())
    .filter(([name]) => !name.startsWith('GIT_') || name === 'GIT_SSH' || name === 'GIT_SSH_COMMAND'))
  // A user's own ssh program keeps precedence; the default only keeps ssh from waiting for a prompt.
  const ssh = env.GIT_SSH === undefined && env.GIT_SSH_COMMAND === undefined ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}
  return {
    ...env, ...ssh, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1', GIT_LITERAL_PATHSPECS: '1',
  }
}

/** Partial clones of detail repositories under one directory, owned by one service. */
export class RepositoryCache {
  private readonly locks = new Map<string, Promise<void>>()
  private readonly heads = new Map<string, Expiring<string>>()
  /**
   * Whether `git --version` has succeeded. A missing Git is checked this way before any operation, because Windows
   * reports a missing command as an ordinary exit code that would otherwise read as a refused fetch.
   */
  private gitStarts = false
  private readonly visibility = new Map<string, Expiring<boolean>>()
  private readonly checks = new Map<string, Promise<boolean>>()
  private readonly running = new Set<Promise<void>>()

  /** @param options - location, limits, deadline, transports, and lifetime. */
  constructor(private readonly options: RepositoryCacheOptions) {}

  /**
   * Whether a repository's smart HTTP endpoint answers without credentials, which makes a missing single-file API answer
   * authoritative. The request carries no user configuration, credential helper, or `.netrc` entry; concurrent checks of
   * one repository share it, and its answer is reused for `ttlMs`.
   * @param url - the repository's https URL, ending in `.git`.
   * @returns true for a 2xx answer; false for 401, 403, 404, or a redirect, which hosts send for a private repository.
   * @throws {DetailFailure} `network` when the host cannot be reached or answers another status.
   */
  isPublic(url: string): Promise<boolean> {
    const cached = this.visibility.get(url)
    if (cached !== undefined && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
    let pending = this.checks.get(url)
    if (pending === undefined) {
      pending = this.check(url).finally(() => { this.checks.delete(url) })
      this.checks.set(url, pending)
    }
    return pending
  }

  private async check(url: string): Promise<boolean> {
    const endpoint = `${url}/info/refs?service=git-upload-pack`
    let response: Response
    try {
      response = await fetch(endpoint, { redirect: 'manual', signal: AbortSignal.any([this.options.lifetime, AbortSignal.timeout(this.options.timeoutMs)]) })
    } catch (error) {
      throw new DetailFailure('network', `Could not reach ${endpoint}: ${(error as Error).message}`, { cause: error })
    }
    await response.body?.cancel()
    const { status } = response
    if (!response.ok && status !== 401 && status !== 403 && status !== 404 && (status < 300 || status > 399)) {
      throw new DetailFailure('network', `${endpoint} answered HTTP ${String(status)}`)
    }
    this.visibility.set(url, { value: response.ok, expiresAt: Date.now() + this.options.ttlMs })
    return response.ok
  }

  /**
   * Read one regular file of a repository.
   * @param url - the repository URL.
   * @param commit - a full commit id, or undefined for the default branch.
   * @param path - `/`-separated path relative to the repository root.
   * @param maxBytes - largest accepted size.
   * @param signal - cancellation of the read.
   * @returns the bytes, or undefined when the commit has no regular file at `path`.
   * @throws {DetailFailure} when Git cannot fetch the commit, the repository grows past its limit, or the file exceeds `maxBytes`.
   */
  read(url: string, commit: string | undefined, path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
    return this.locked(url, async (repository) => {
      const resolved = await this.commit(repository, url, commit, signal)
      const blob = (await this.files(repository, resolved, path, signal)).get(path)
      return blob === undefined ? undefined : await this.blob(repository, url, blob, path, maxBytes, signal)
    })
  }

  /**
   * Read the README of a repository directory: `README.md`, `README.markdown`, or `README` in any letter case.
   * @param url - the repository URL.
   * @param commit - a full commit id, or undefined for the default branch.
   * @param dir - directory relative to the repository root; `''` for the root.
   * @param maxBytes - largest accepted size.
   * @param signal - cancellation of the read.
   * @returns the file, or undefined when the directory has none.
   * @throws {DetailFailure} as {@link read} does.
   */
  readme(url: string, commit: string | undefined, dir: string, maxBytes: number, signal: AbortSignal): Promise<FoundFile | undefined> {
    return this.locked(url, async (repository) => {
      const resolved = await this.commit(repository, url, commit, signal)
      const files = await this.files(repository, resolved, dir === '' ? undefined : `${dir}/`, signal)
      const prefix = dir === '' ? '' : `${dir}/`
      const name = readmeName([...files.keys()].map(path => path.slice(prefix.length)))
      if (name === undefined) return undefined
      const path = `${prefix}${name}`
      return { path, bytes: await this.blob(repository, url, files.get(path) as string, path, maxBytes, signal) }
    })
  }

  /** Wait until every running Git command has ended; the lifetime signal stops them. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.running])
  }

  /**
   * Serialize operations on one repository, so a fetch and the reads after it never interleave, and delete the
   * repository when an operation fails or is cancelled for any reason but a file over its read's size.
   */
  private locked<T>(url: string, operation: (repository: string) => Promise<T>): Promise<T> {
    const repository = join(this.options.dir, createHash('sha256').update(url).digest('hex').slice(0, 24))
    return this.serialized(repository, () => operation(repository).catch(async (error: unknown) => {
      if (!(error instanceof FileTooLarge)) await rm(repository, { recursive: true, force: true })
      throw error
    }))
  }

  /**
   * Run an operation after every earlier operation on the same repository directory has ended, in this service and in
   * other processes that share the cache directory, such as Web and Desktop on one profile.
   */
  private serialized<T>(repository: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(repository) ?? Promise.resolve()
    const next = previous.then(async () => {
      await mkdir(this.options.dir, { recursive: true })
      // An operation runs at most this many Git commands, each bounded by the Git deadline.
      const waitMs = OPERATION_COMMANDS * this.options.timeoutMs
      return await withFileLock(repository, operation, { waitMs, signal: this.options.lifetime })
    })
    // The caller receives the outcome; the lock and the settlement wait only for completion.
    const tracked: Promise<void> = next.then(() => undefined, () => undefined).finally(() => {
      if (this.locks.get(repository) === tracked) this.locks.delete(repository)
      this.running.delete(tracked)
    })
    this.locks.set(repository, tracked)
    this.running.add(tracked)
    return next
  }

  /** The commit to read: a fetched commit, fetching it or the default branch when necessary. */
  private async commit(repository: string, url: string, commit: string | undefined, signal: AbortSignal): Promise<string> {
    if (!this.gitStarts) {
      // `git version <release>` is one short line.
      await this.run(this.options.dir, ['--version'], signal, 1024).catch((error: unknown) => {
        throw new DetailFailure('git-unavailable', (error as Error).message, { cause: error })
      })
      this.gitStarts = true
    }
    if (!existsSync(repository)) {
      // A repository appears complete or not at all: it is initialized beside its final name, then renamed.
      const staging = await mkdtemp(join(this.options.dir, STAGING_PREFIX))
      try {
        await this.run(staging, ['init', '--quiet', '--bare', '--template='], signal)
        for (const [key, value] of [['remote.origin.url', url], ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none']]) {
          await this.run(staging, ['config', key as string, value as string], signal)
        }
        await rename(staging, repository)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
    await utimes(repository, new Date(), new Date())
    // An object lookup would fetch a missing commit lazily from the promisor remote, without the size watch; a ref
    // written after a completed fetch records the commit instead, and eviction removes it with the repository.
    const head = this.heads.get(url)
    const known = commit ?? (head !== undefined && head.expiresAt > Date.now() ? head.value : undefined)
    if (known !== undefined && !(await this.git(['show-ref', '--verify', '--quiet', `refs/dsh/${known}`], repository, signal)).failed) return known
    await this.fetch(repository, url, commit ?? 'HEAD', signal)
    const fetched = commit ?? (await this.run(repository, ['rev-parse', 'FETCH_HEAD'], signal)).toString('utf8').trim()
    await this.run(repository, ['update-ref', `refs/dsh/${fetched}`, fetched], signal)
    if (commit === undefined) this.heads.set(url, { value: fetched, expiresAt: Date.now() + this.options.ttlMs })
    return fetched
  }

  /** Fetch one commit without file contents. */
  private async fetch(repository: string, url: string, target: string, signal: AbortSignal): Promise<void> {
    const args = ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', target]
    await this.watched(repository, url, args, signal, `${url}: git fetch`)
    await this.evict(repository)
  }

  /**
   * Run a Git command that may download objects, stopping it when the repository grows past its limit during or by the
   * command; the caller's lock then deletes the repository.
   */
  private async watched(
    repository: string, url: string, args: readonly string[], signal: AbortSignal, label: string,
    maxBuffer = this.options.maxRepositoryBytes,
  ): Promise<GitResult> {
    const limit = this.options.maxRepositoryBytes
    // The limit applies to what one command adds, so a clone that earlier reads filled stays usable.
    const before = await sizeOf(repository)
    const oversized = new AbortController()
    const timer = setInterval(() => {
      void sizeOf(repository).then((size) => { if (size - before > limit) oversized.abort() }, /* v8 ignore next -- Git renamed or
        deleted a file during the walk, which no test can time; the next tick measures again */ (_racing: unknown) => {})
    }, this.options.sizePollMs)
    let result: GitResult
    try {
      result = await this.git(args, repository, signal, oversized.signal, maxBuffer)
    } finally {
      clearInterval(timer)
    }
    if (oversized.signal.aborted || (!result.failed && await sizeOf(repository) - before > limit)) {
      throw new DetailFailure('too-large', `${url}: one fetch adds more than ${String(limit)} bytes`)
    }
    if (result.failed && !result.overflowed) throw remoteFailureOf(result, label)
    return result
  }

  /**
   * Delete least recently used repositories until the cache fits, `kept` last, and staging directories older than the
   * Git deadline. Each deletion is queued behind the operations on its repository and not awaited, because the caller
   * holds the lock of `kept` and another repository's queued operation may be waiting to evict `kept`.
   */
  private async evict(kept: string): Promise<void> {
    const now = Date.now()
    const entries: { path: string; size: number; used: number }[] = []
    for (const entry of await readdir(this.options.dir, { withFileTypes: true })) {
      const path = join(this.options.dir, entry.name)
      try {
        const used = (await stat(path)).mtimeMs
        if (entry.name.startsWith(STAGING_PREFIX)) {
          if (now - used > this.options.timeoutMs) await rm(path, { recursive: true, force: true })
        } else if (entry.isDirectory()) {
          entries.push({ path, size: await sizeOf(path), used })
        }
      } catch (_removed) {
        // Another operation deleted the directory while it was measured; it no longer counts.
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    // The repository in use goes last: it is deleted only when it alone exceeds the cache, after its operation ends.
    for (const entry of entries.sort((a, b) => Number(a.path === kept) - Number(b.path === kept) || a.used - b.used)) {
      if (total <= this.options.maxCacheBytes) return
      void this.serialized(entry.path, () => rm(entry.path, { recursive: true, force: true })).catch(/* v8 ignore next -- a
        forced recursive delete fails only on file permissions no test sets; the repository stays and is measured again
        after the next fetch */ (_unremovable: unknown) => {})
      total -= entry.size
    }
  }

  /**
   * The regular files directly below a tree path, or the file at a path, with their blob ids; listing reads only trees,
   * so it fetches no file contents.
   */
  private async files(repository: string, commit: string, path: string | undefined, signal: AbortSignal): Promise<Map<string, string>> {
    const listing = (await this.run(repository, ['ls-tree', '-z', commit, ...path === undefined ? [] : ['--', path]], signal)).toString('utf8')
    const files = new Map<string, string>()
    for (const line of listing.split('\0')) {
      // Symbolic links (120000), submodules (160000), and trees are not files.
      const fields = /^100(?:644|755) blob ([0-9a-f]+)\t(.+)$/su.exec(line)
      if (fields !== null) files.set(fields[2] as string, fields[1] as string)
    }
    return files
  }

  /** Read a blob, fetching its contents under the repository size limit when the clone does not hold them yet. */
  private async blob(
    repository: string, url: string, blob: string, path: string, maxBytes: number, signal: AbortSignal,
  ): Promise<Uint8Array> {
    // The buffer stops Git once the contents pass `maxBytes`, so an oversized file never enters memory whole.
    const result = await this.watched(repository, url, ['cat-file', 'blob', blob], signal, `git cat-file ${path}`, maxBytes)
    if (result.overflowed) throw new FileTooLarge(path, maxBytes)
    // Reading a blob can download it, so the cache total is enforced after every read as after every fetch.
    await this.evict(repository)
    return result.stdout
  }

  /**
   * Run a Git command on local objects and return its output. A failure, such as a missing Git, a full disk, or a timeout,
   * is a plain error: it says nothing about the repository, so no read caches it.
   */
  private async run(repository: string, args: readonly string[], signal: AbortSignal, maxBuffer?: number): Promise<Buffer> {
    const result = await this.git(args, repository, signal, undefined, maxBuffer)
    if (result.failed) throw new Error(`git ${args[0] as string}: ${result.diagnostic}`)
    return result.stdout
  }

  /**
   * Run Git with options that keep it from running repository-supplied programs and allow only the configured transports.
   * Cancellation by `signal` or the lifetime rejects with its reason; `stop` ends Git with a failed result.
   */
  private async git(
    args: readonly string[], cwd: string, signal: AbortSignal, stop?: AbortSignal, maxBuffer = this.options.maxRepositoryBytes,
  ): Promise<GitResult> {
    const safety = [
      // An empty `core.askPass` ends Git's askpass lookup where Windows drops the empty `GIT_ASKPASS`, so no dialog opens.
      'core.askPass=', 'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'submodule.recurse=false', 'gc.auto=0', 'maintenance.auto=false',
      'protocol.allow=never', ...this.options.transports.map(transport => `protocol.${transport}.allow=always`),
    ].flatMap(setting => ['-c', setting])
    const result = await execa('git', [...safety, ...args], {
      // A blob's last byte may be a newline, so the output is kept exactly as Git wrote it.
      cwd, env: gitEnv(), extendEnv: false, stdin: 'ignore', encoding: 'buffer', stripFinalNewline: false, reject: false,
      maxBuffer: { stdout: maxBuffer, stderr: this.options.maxRepositoryBytes },
      timeout: this.options.timeoutMs, cancelSignal: AbortSignal.any([signal, this.options.lifetime, ...stop === undefined ? [] : [stop]]),
      killDescendants: true, killSignal: 'SIGKILL',
    })
    signal.throwIfAborted()
    this.options.lifetime.throwIfAborted()
    // Git that is missing or cannot run says nothing about the repository, so no read caches the failure.
    return {
      stdout: Buffer.from(result.stdout), failed: result.failed,
      overflowed: result.isMaxBuffer && result.stdout.byteLength >= maxBuffer,
      diagnostic: `${String(result.shortMessage)}\n${Buffer.from(result.stderr).toString('utf8').trim()}`,
    }
  }
}
