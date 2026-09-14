/** Filesystem provider preserving remote identities and helper-owned atomic mutations. */
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-ssh'
import { RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { editResultSchema, entriesSchema, infoSchema, pathInfoSchema, targetSchema, textStreamIdSchema, writeResultSchema } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'

const errorCodes: Record<FsErrorCode, true> = {
  FS_NOT_FOUND: true, FS_NOT_DIRECTORY: true, FS_NOT_TEXT: true, FS_NOT_REGULAR_FILE: true,
  FS_TOO_LARGE: true, FS_PERMISSION_DENIED: true, FS_SANDBOX_DENIED: true, FS_IO_ERROR: true,
  FS_STALE_VERSION: true, FS_NOT_OBSERVED: true, FS_AMBIGUOUS_EDIT: true, FS_EDIT_NOT_FOUND: true, FS_ABORTED: true,
}

/** Remote filesystem paired with the SSH subprocess and sandbox providers. */
export class SshFileSystem extends FileSystem {
  static inject = ['ssh', 'sandboxPolicy']

  override get sandboxMode(): SandboxMode { return this.ctx.sandboxPolicy.defaultMode }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return await this.call('fs.resolve', { path, cwd: opts?.cwd }, targetSchema, opts?.signal) as FsTarget
  }

  override processPath(target: FsTarget): string { return String(target.targetKey) }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = posix.relative(this.processPath(parent), this.processPath(child))
    return path === '' || (!path.startsWith('../') && path !== '..' && !posix.isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return await this.call('fs.stat', { target }, infoSchema.nullable(), signal) as FsInfo | null ?? undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return await this.call('fs.lstat', { path, cwd: opts?.cwd }, pathInfoSchema.nullable(), signal) as FsPathInfo | null ?? undefined
  }

  override readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.call('fs.readText', { target }, z.string(), signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const id = await this.call('fs.stream', { target }, textStreamIdSchema, signal)
    const call = this.call.bind(this)
    return (async function* () {
      let ended = false
      try {
        while (!ended) {
          signal?.throwIfAborted()
          const next = await call('fs.next', { id }, z.object({ done: z.boolean(), value: z.string() }).strict(), signal)
          ended = next.done
          if (next.value.length > 0) yield next.value
        }
      } finally {
        if (!ended) await call('fs.streamClose', { id }, z.null()).catch(() => {})
      }
    })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return Buffer.from(await this.call('fs.readBytes', { target, maxBytes }, z.base64(), signal), 'base64')
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return Buffer.from(await this.call('fs.readRange', { target, ...range }, z.base64(), signal), 'base64')
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return await this.call('fs.list', { target }, entriesSchema, signal) as FsDirEntry[]
  }

  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    return await this.call('fs.write', { target, content, expected, policy }, writeResultSchema, signal) as FsWriteOutcome
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion },
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    return await this.call('fs.edit', { target, edit, expected, policy }, editResultSchema, signal) as FsEditOutcome
  }

  private async call<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    try { return await this.ctx.ssh.request(method, params, schema, signal) } catch (error) {
      if (error instanceof RemoteOperationError && error.code !== undefined && Object.hasOwn(errorCodes, error.code)) {
        throw new FsError(error.message, error.code as FsErrorCode, { cause: error })
      }
      throw new FsError(error instanceof Error ? error.message : String(error), signal?.aborted ? 'FS_ABORTED' : 'FS_IO_ERROR', { cause: error })
    }
  }
}

export default SshFileSystem
