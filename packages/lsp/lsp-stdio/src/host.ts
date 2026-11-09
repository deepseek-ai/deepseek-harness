/** Filesystem-seam source access for the generic stdio LSP provider. */

import { Buffer } from 'node:buffer'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { LspError } from '@deepseek-ai/dsh-lsp'
import { throwIfAborted } from './abort.ts'

/** A canonical workspace in the filesystem/subprocess execution world. */
export interface HostWorkspace {
  /** Stable filesystem identity used for provider pooling. */
  readonly target: FsTarget
  /** Canonical absolute path accepted as a subprocess cwd. */
  readonly canonicalPath: string
  /** Canonical file URI sent during LSP initialization. */
  readonly fileUrl: string
}

/** A validated source and the exact URI sent to the language server. */
export interface HostSource {
  /** Canonical file URI in the execution world's platform syntax. */
  readonly fileUrl: string
  /** Current complete UTF-8 text. */
  readonly text: string
}

/**
 * Resolve and validate one workspace through `ctx.fs`.
 * @param fs - filesystem provider sharing the language server's execution world.
 * @param workspaceRoot - caller-supplied workspace path.
 * @param signal - optional cancellation around provider operations.
 * @returns stable identity plus process path and file URI.
 * @throws FsError with the provider's code when resolution or `stat` fails, `FS_NOT_FOUND` when the
 *   workspace is missing, or `FS_NOT_DIRECTORY` when it is not a directory.
 */
export async function canonicalizeWorkspace(
  fs: FileSystem,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<HostWorkspace> {
  throwIfAborted(signal)
  let target: FsTarget
  try {
    target = await fs.resolve(workspaceRoot, signal === undefined ? {} : { signal })
  } catch (error: unknown) {
    throwIfAborted(signal)
    rethrowWithFsContext(error, `workspace root "${workspaceRoot}" cannot be resolved`)
  }
  throwIfAborted(signal)
  const info = await fs.stat(target, signal).catch((error: unknown) => {
    throwIfAborted(signal)
    throw error
  })
  throwIfAborted(signal)
  if (info === undefined) {
    throw new FsError(`workspace root "${workspaceRoot}" does not exist`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'directory') {
    throw new FsError(`workspace root "${workspaceRoot}" is not a directory`, 'FS_NOT_DIRECTORY')
  }
  return {
    target,
    canonicalPath: fs.processPath(target),
    fileUrl: fs.fileUrl(target),
  }
}

/**
 * Resolve, contain, and read one byte-bounded query source through `ctx.fs`.
 * This layer owns the LSP-specific complete-document cap while the filesystem
 * provider owns streaming, regular-file checks, and UTF-8 validation.
 * @param fs - filesystem provider sharing the server's execution world.
 * @param filePath - absolute source path or path relative to `workspace`.
 * @param workspace - already-canonical workspace.
 * @param maxDocumentBytes - largest complete source accepted by this host.
 * @param signal - optional cancellation.
 * @returns canonical file URI and current text.
 * @throws FsError with the provider's code when resolution or reading fails, or `FS_TOO_LARGE` when
 *   the source exceeds `maxDocumentBytes`; LspError `LSP_FILE_OUTSIDE_WORKSPACE` when the source
 *   resolves outside `workspace`.
 */
export async function readHostSource(
  fs: FileSystem,
  filePath: string,
  workspace: HostWorkspace,
  maxDocumentBytes: number,
  signal?: AbortSignal,
): Promise<HostSource> {
  throwIfAborted(signal)
  let target: FsTarget
  try {
    target = await fs.resolve(filePath, {
      cwd: workspace.canonicalPath,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    throwIfAborted(signal)
    rethrowWithFsContext(error, `source "${filePath}" cannot be resolved`)
  }
  throwIfAborted(signal)
  if (!fs.contains(workspace.target, target)) {
    throw new LspError(`source "${filePath}" resolves outside the workspace`, 'LSP_FILE_OUTSIDE_WORKSPACE')
  }
  const chunks: string[] = []
  let bytes = 0
  try {
    // XXX(lsp-source-replacement): Revisit stable-handle identity only if a real query observes
    // replacement between canonical containment and the provider opening this stream.
    const stream = await fs.streamText(target, signal)
    for await (const chunk of stream) {
      throwIfAborted(signal)
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxDocumentBytes) break
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    throwIfAborted(signal)
    rethrowWithFsContext(error, `source "${filePath}" could not be read`)
  }
  if (bytes > maxDocumentBytes) {
    throw new FsError(
      `source "${filePath}" exceeds the ${maxDocumentBytes}-byte limit; reading stopped after ${bytes} bytes`,
      'FS_TOO_LARGE',
    )
  }
  throwIfAborted(signal)
  return {
    fileUrl: fs.fileUrl(target),
    text: chunks.join(''),
  }
}

/**
 * Prefix a filesystem provider failure with the LSP operand while keeping its `FsError` code; any
 * other thrown value is a provider defect and propagates unchanged.
 */
function rethrowWithFsContext(error: unknown, context: string): never {
  if (!(error instanceof FsError)) throw error
  throw new FsError(`${context}: ${error.message}`, error.code, { cause: error })
}
