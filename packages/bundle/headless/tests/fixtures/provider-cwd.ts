/** Empty POSIX filesystem fixture whose execution coordinates differ from the Harness host. */
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion, type FsTarget, type FsInfo } from '@deepseek-ai/dsh-fs'
import schema from '@deepseek-ai/schemastery'

/** Deployment coordinates for the deterministic provider. */
interface Config { root: string }

/** Empty provider-owned workspace; no operation accesses the host filesystem. */
export default class ProviderCwdFileSystem extends FileSystem {
  override watch(): never { throw new Error('Fixture does not support watching') }
  static inject = ['sandboxPolicy']
  static Config: schema<Config> = schema.object({ root: schema.string().required() })
  private readonly config: Config
  constructor(ctx: Context, config: Config) { super(ctx); this.config = config }

  override get sandboxMode(): 'read-only' { return 'read-only' }
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    const absolute = posix.resolve(opts?.cwd ?? this.config.root, path)
    return { targetKey: FsTargetKey(absolute), displayPath: path }
  }
  override processPath(target: FsTarget): string { return String(target.targetKey) }
  override fileUrl(target: FsTarget): string {
    const url = new URL('file:///')
    url.pathname = this.processPath(target)
    return url.href
  }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../'))
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    return this.processPath(target) === this.config.root ? { type: 'directory', version: FsVersion('empty-workspace') } : undefined
  }
  override async lstat(path: string, opts?: { cwd?: string }): Promise<FsInfo | undefined> {
    return this.stat(await this.resolve(path, opts))
  }
  override async listDir(target: FsTarget): Promise<[]> {
    if ((await this.stat(target))?.type !== 'directory') throw new FsError('No such provider directory', 'FS_NOT_FOUND')
    return []
  }
  override async readText(): Promise<never> { throw new FsError('No such provider file', 'FS_NOT_FOUND') }
  override async streamText(): Promise<never> { throw new FsError('No such provider file', 'FS_NOT_FOUND') }
  override async readBytes(): Promise<never> { throw new FsError('No such provider file', 'FS_NOT_FOUND') }
  override async readByteRange(): Promise<never> { throw new FsError('No such provider file', 'FS_NOT_FOUND') }
  override async writeText(): Promise<never> { throw new FsError('Read-only provider fixture', 'FS_SANDBOX_DENIED') }
  override async editText(): Promise<never> { throw new FsError('Read-only provider fixture', 'FS_SANDBOX_DENIED') }
}
