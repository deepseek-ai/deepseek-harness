/**
 * Download package files without running their code. npm tarballs are streamed under a size limit, verified against the
 * registry integrity, and unpacked in memory. Git objects are fetched into a private temporary bare repository with
 * hooks, the file-system monitor, submodules, and all but the allowed transports disabled, and files are read as blobs:
 * no working tree is created, so no checkout filter, LFS download, or symbolic link takes effect.
 */
import { createHash, getHashes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Parser, type ReadEntry } from 'tar'
import { PackageFiles, type FileEntry } from './files.ts'
import { readManifest, type Manifest } from './packages.ts'

const run = promisify(execFile)

/** Network limits for one source. */
export interface FetchLimits {
  readonly timeoutMs: number
  /** Largest npm tarball accepted, in bytes, both compressed and unpacked. */
  readonly maxTarballBytes: number
}

/** The registry document of one npm package; only the fields the generator reads are typed. */
export interface Packument {
  readonly 'dist-tags'?: { readonly latest?: unknown }
  readonly time?: Readonly<Record<string, unknown>>
  readonly versions?: Readonly<Record<string, Manifest & { readonly dist?: { readonly tarball?: unknown; readonly integrity?: unknown } }>>
}

/**
 * Hash a value into a short cache-path component.
 * @param value - the identity to hash.
 * @returns 24 hexadecimal characters.
 */
export function cacheKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

/**
 * Read the registry document of an npm package.
 * @param registry - registry base URL ending in `/`.
 * @param name - package name.
 * @param limits - request deadline.
 * @returns the parsed document.
 */
export async function npmPackument(registry: string, name: string, limits: FetchLimits): Promise<Packument> {
  const response = await fetch(new URL(name.replace('/', '%2f'), registry), { signal: AbortSignal.timeout(limits.timeoutMs) })
  if (!response.ok) throw new Error(`${name}: registry answered HTTP ${response.status}`)
  return await response.json() as Packument
}

/** Whether `bytes` match one supported hash of a subresource-integrity string. */
function matchesIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const supported = new Set(getHashes())
  const hashes = integrity.trim().split(/\s+/u).map(token => /^(sha\d+)-([A-Za-z0-9+/=]+)/u.exec(token)).filter(match => match !== null)
  const usable = hashes.filter(([, algorithm]) => supported.has(algorithm as string))
  return usable.length > 0 && usable.some(([, algorithm, digest]) => createHash(algorithm as string).update(bytes).digest('base64') === digest)
}

/** Unpack the regular files of an npm tarball below its top directory, without `node_modules`, into memory. */
function unpack(bytes: Uint8Array, label: string, maxBytes: number): Promise<PackageFiles> {
  return new Promise((resolve, reject) => {
    const files = new Map<string, FileEntry>()
    let total = 0
    const parser = new Parser({ strict: true })
    parser.on('entry', (entry: ReadEntry) => {
      const path = PackageFiles.resolve('', entry.path.split('/').slice(1).join('/'))
      if (entry.type !== 'File' || path === undefined || path === '' || path.split('/').includes('node_modules')) {
        entry.resume()
        return
      }
      const chunks: Buffer[] = []
      entry.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) parser.abort(new Error(`unpacked tarball exceeds ${maxBytes} bytes`))
        else chunks.push(chunk)
      })
      entry.on('end', () => {
        const contents = Buffer.concat(chunks)
        files.set(path, { size: contents.length, read: () => Promise.resolve(contents) })
      })
    })
    parser.on('error', (error: Error) => { reject(new Error(`${label}: ${error.message}`)) })
    parser.on('end', () => { resolve(new PackageFiles(files)) })
    parser.end(Buffer.from(bytes))
  })
}

/**
 * Download, verify, and unpack an npm tarball in memory. Its `package.json` must name the requested package and version.
 * @param name - package name.
 * @param version - exact version.
 * @param dist - the version's registry `dist` fields.
 * @param limits - request deadline and size bound.
 * @returns the package files and its manifest.
 */
export async function npmTarball(
  name: string, version: string, dist: { readonly tarball?: unknown; readonly integrity?: unknown } | undefined, limits: FetchLimits,
): Promise<{ files: PackageFiles; manifest: Manifest }> {
  const label = `${name}@${version}`
  if (typeof dist?.tarball !== 'string' || typeof dist.integrity !== 'string') throw new Error(`${label}: registry lists no tarball with integrity`)
  const response = await fetch(dist.tarball, { signal: AbortSignal.timeout(limits.timeoutMs) })
  if (!response.ok) throw new Error(`${label}: tarball answered HTTP ${response.status}`)
  const chunks: Uint8Array[] = []
  let total = 0
  // A successful response has a body; throwing inside the loop cancels it.
  for await (const chunk of response.body as ReadableStream<Uint8Array>) {
    total += chunk.length
    if (total > limits.maxTarballBytes) throw new Error(`${label}: tarball exceeds ${limits.maxTarballBytes} bytes`)
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (!matchesIntegrity(bytes, dist.integrity)) throw new Error(`${label}: tarball does not match its registry integrity`)
  const files = await unpack(bytes, label, limits.maxTarballBytes)
  const manifest = await readManifest(files, '')
  if (manifest?.name !== name || manifest.version !== version) throw new Error(`${label}: tarball package.json does not name ${label}`)
  return { files, manifest }
}

/** Git transport names, such as `https`, `ssh`, or `file`. */
export type GitTransports = readonly string[]

/** The default branch commit and the tags of a remote repository. */
export interface RemoteRefs {
  readonly head: string
  /** Commit of each tag by tag name; annotated tags are peeled. */
  readonly tags: ReadonlyMap<string, string>
}

/** The environment of every Git command: the caller's, without Git overrides, and without prompts or LFS downloads. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') || name === 'GIT_SSH' || name === 'GIT_SSH_COMMAND'))
  // A user's own ssh program keeps precedence; the default only keeps ssh from waiting for a prompt.
  const ssh = env.GIT_SSH === undefined && env.GIT_SSH_COMMAND === undefined ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', ...ssh }
}

/**
 * Run Git with options that keep it from running repository-supplied programs and allow only `transports`;
 * `url.<base>.insteadOf` in the user's configuration still applies, so an https URL can be routed to ssh.
 */
function git(
  args: readonly string[], transports: GitTransports, limits: FetchLimits, cwd?: string, input?: string,
): Promise<{ stdout: Buffer }> {
  const safety = [
    'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'submodule.recurse=false', 'gc.auto=0', 'maintenance.auto=false', 'protocol.allow=never',
    ...transports.map(transport => `protocol.${transport}.allow=always`),
  ].flatMap(setting => ['-c', setting])
  const command = run('git', [...safety, ...args], { cwd, env: gitEnv(), timeout: limits.timeoutMs, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  // Git may exit before it reads its input; the exit status reports that failure, so the broken pipe is not a
  // second one. Whether the write races the exit depends on scheduling, so no test reaches the handler reliably.
  /* v8 ignore next */
  command.child.stdin?.on('error', () => {})
  command.child.stdin?.end(input ?? '')
  return command
}

/**
 * List the default branch commit and the tags of a repository.
 * @param url - repository URL.
 * @param transports - allowed Git transports.
 * @param limits - command deadline.
 * @returns the refs.
 */
export async function gitRefs(url: string, transports: GitTransports, limits: FetchLimits): Promise<RemoteRefs> {
  const { stdout } = await git(['ls-remote', '--', url, 'HEAD', 'refs/tags/*'], transports, limits)
  let head: string | undefined
  const tags = new Map<string, string>()
  for (const [, commit, ref] of stdout.toString('utf8').matchAll(/^([0-9a-f]{40})\t(\S+)$/gmu)) {
    if (ref === 'HEAD') head = commit
    const tag = /^refs\/tags\/(.+?)(\^\{\})?$/u.exec(ref as string)
    // A peeled `^{}` line follows its annotated tag and replaces the tag object with the commit.
    if (tag !== null) tags.set(tag[1] as string, commit as string)
  }
  if (head === undefined) throw new Error(`${url}: no HEAD commit`)
  return { head, tags }
}

/** Objects fetched from one repository into a private bare repository. */
export interface GitObjects {
  /**
   * Fetch commits with depth 1 in one request, skipping commits already fetched. When the server refuses a request by
   * commit, the refs that point to the commits are fetched by name instead.
   * @param commits - commits listed by {@link gitRefs}.
   */
  fetch(commits: readonly string[]): Promise<void>
  /**
   * @param commit - a commit listed by {@link gitRefs}; it is fetched first when necessary.
   * @param path - the directory to list, `''` for the whole tree.
   * @returns the regular files below `path`, with paths relative to it, read on demand.
   */
  tree(commit: string, path: string): Promise<PackageFiles>
  /**
   * @param commit - a fetched commit.
   * @returns its committer time in Unix seconds.
   */
  committed(commit: string): Promise<number>
}

/**
 * Run `read` with a private temporary bare repository for `url`, then delete it.
 * @param url - repository URL.
 * @param refs - the repository's refs, which name the commits for a fetch by name.
 * @param transports - allowed Git transports.
 * @param limits - command deadline.
 * @param read - fetches and reads objects.
 * @returns what `read` returns.
 */
export async function withGitObjects<T>(
  url: string, refs: RemoteRefs, transports: GitTransports, limits: FetchLimits, read: (objects: GitObjects) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-market-git-'))
  const inRepository = (args: readonly string[], input?: string) => git(args, transports, limits, dir, input)
  const names = new Map([...[...refs.tags].map(([tag, commit]) => [commit, `refs/tags/${tag}`] as const), [refs.head, 'HEAD']])
  const fetched = new Set<string>()
  const listTree = async (commit: string, path: string) => {
    const scope = path === '' ? [] : ['--', `${path}/`]
    const listing = (await inRepository(['ls-tree', '-r', '-l', '-z', '--full-tree', commit, ...scope])).stdout.toString('utf8')
    const prefix = path === '' ? '' : `${path}/`
    const files = new Map<string, FileEntry>()
    for (const line of listing.split('\0')) {
      // Symbolic links (120000) and submodules (160000) are not files.
      const fields = /^100(?:644|755) blob (?<blob>[0-9a-f]+) +(?<size>\d+)\t(?<file>.+)$/su.exec(line)?.groups
      if (fields === undefined) continue
      const { blob, size, file } = fields as { blob: string; size: string; file: string }
      files.set(file.slice(prefix.length), { size: Number(size), read: async () => (await inRepository(['cat-file', 'blob', blob])).stdout })
    }
    return new PackageFiles(files)
  }
  const objects: GitObjects = {
    async fetch(commits) {
      const wanted = [...new Set(commits)].filter(commit => !fetched.has(commit))
      if (wanted.length === 0) return
      // Targets go through standard input, so any number of commits fits on the command line.
      const fetch = (targets: readonly string[]) => inRepository(['fetch', '--quiet', '--depth', '1', '--no-tags', '--stdin', '--', url], `${targets.join('\n')}\n`)
      await fetch(wanted).catch((_refused: unknown) => fetch(wanted.map(commit => names.get(commit) as string)))
      for (const commit of wanted) fetched.add(commit)
    },
    async tree(commit, path) {
      await objects.fetch([commit])
      return listTree(commit, path)
    },
    async committed(commit) {
      // The raw commit object, so no user formatting option such as signature display runs on repository data.
      const header = (await inRepository(['cat-file', 'commit', commit])).stdout.toString('utf8')
      const time = /^committer .* (\d+) [+-]\d{4}$/mu.exec(header)?.[1]
      /* v8 ignore next -- Git writes a committer line into every commit object */
      if (time === undefined) throw new Error(`${commit}: commit has no committer time`)
      return Number(time)
    },
  }
  try {
    await inRepository(['init', '--quiet', '--bare'])
    return await read(objects)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
