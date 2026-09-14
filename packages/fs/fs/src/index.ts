/**
 * Filesystem Service Definition for one execution world. Backends own stable target
 * identity, process paths and file URIs, containment, text reads, decoding,
 * binary rejection, and atomic mutations. Read windows and
 * observed-state policy stay in consumer and policy plugins; `editText`
 * remains here so version check, literal match, and rewrite share one critical
 * section.
 * @module @deepseek-ai/dsh-fs
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsObservation,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

export {
  FsError,
  FsTargetKey,
  FsVersion,
} from './types.ts'
export type {
  FsEditOutcome,
  FsEditRequest,
  FsDirEntry,
  FsErrorCode,
  FsInfo,
  FsObservation,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FileSystem
  }

  interface Events {
    /**
     * Single-slot decision for the next {@link FileSystem.writeText}. Calling
     * `next()` yields the bare provider's unconditional write; the first listener
     * that returns an intent owns the decision rather than composing with peers.
     * @param target - the resolved target about to be written.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
    /**
     * Single-slot decision for the next {@link FileSystem.editText}. Calling
     * `next()` yields an unconditional edit; the first returned guard wins.
     * @param target - the resolved target about to be edited.
     * @param actor - the opaque tool-execution context the decider keys off.
     * @mode waterfall
     */
    'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
    /**
     * Record an authoritative positive or negative observation. Listeners must
     * be synchronous recorders: throws fail the tool call and returned promises
     * are not awaited.
     * @param target - the target whose presence or absence was observed.
     * @param observation - present with its version, or confirmed absent.
     * @param actor - the observing tool-execution context; undefined records nothing useful.
     * @mode emit
     */
    'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
  }
}

/**
 * Abstract filesystem provider. Targets must preserve identity across aliases;
 * reads expose regular UTF-8 text or typed errors, listings are stable and
 * content-free, and mutations are atomic. Optional guards add stale protection
 * without changing the unguarded provider contract.
 */
export abstract class FileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * The sandbox mode this backend enforces on mutations BY DEFAULT, or
   * `undefined` when it does not confine at all — the capability fact the tool
   * layer reads to advertise the escalation fields honestly (mirrors
   * `ShellExecutor.sandboxMode`). The base class and the bare local backend
   * report `undefined`; a sandboxing backend (`@deepseek-ai/dsh-fs-sandbox`)
   * overrides it with the deployment default. A session override may make the
   * effective mode narrower or wider, so strict escalation widening is checked
   * per call rather than encoded in this default-relative fact.
   * @returns the configured default mode of a sandboxing backend; `undefined`
   *   for a backend that never confines.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * Resolve a model/plugin-supplied path into a stable {@link FsTarget}. May perform I/O (a
   * remote/sandboxed backend may need a round-trip to map a path to a stable identity), hence
   * async even though the local backend only normalizes + realpaths.
   *
   * @param path - the path to resolve; relative paths resolve against `opts.cwd`.
   * @param opts - optional cwd override and cancellation signal.
   * @returns the stable target; the same file yields the same `targetKey`.
   */
  abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>

  /**
   * Return the canonical absolute path a subprocess in this filesystem's
   * execution world can open. The path is deliberately separate from
   * {@link FsTarget.targetKey}: consumers may pass this value to another OS
   * capability, but must continue treating the target key as opaque.
   * @param target - the resolved target whose process path is required.
   * @returns an absolute path in the backend's execution world.
   */
  abstract processPath(target: FsTarget): string

  /**
   * Map an absolute path from the harness host into this filesystem's
   * execution world when both paths identify the same file. The base provider
   * exposes no mapping; host-backed or explicitly shared backends override it.
   * @param hostPath - absolute path in the harness host filesystem.
   * @returns the process path for the same file, or undefined when this
   *   execution world cannot read that host file.
   */
  processPathFromHostPath(hostPath: string): string | undefined {
    void hostPath
    return undefined
  }

  /**
   * Return the canonical `file:` URI for a target in this filesystem's
   * execution world. Backends own URI encoding because the host platform may
   * differ from the execution platform.
   * @param target - the resolved target to encode.
   * @returns the target's canonical file URI.
   */
  abstract fileUrl(target: FsTarget): string

  /**
   * Test canonical containment without exposing or parsing backend target
   * keys. Both targets must come from this provider.
   * @param parent - canonical directory target.
   * @param child - canonical candidate target.
   * @returns true when `child` is `parent` or a descendant of it.
   */
  abstract contains(parent: FsTarget, child: FsTarget): boolean

  /**
   * Return target metadata, or `undefined` when the target does not exist.
   * @param target - the resolved target to stat.
   * @param signal - aborts the metadata round-trip.
   * @returns metadata only, never content; undefined for an absent target.
   */
  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>

  /**
   * Return path metadata without following the final path component when it is a
   * symbolic link. This is intentionally path-shaped, not target-shaped:
   * {@link resolve} follows symlinks to produce the stable identity used by
   * normal reads/writes, while `lstat` lets a consumer reject the path itself
   * before that follow happens.
   *
   * `opts.cwd` follows {@link resolve}'s cwd rules. `undefined` means the path is
   * absent.
   * @param path - the path to inspect; relative paths resolve against `opts.cwd`.
   * @param opts - `cwd` overrides the backend's default base for relative paths.
   * @param signal - aborts the metadata round-trip.
   * @returns metadata only, never content; undefined for an absent path.
   */
  abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>

  /**
   * Read the whole regular text file as a single decoded string.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @returns the full decoded UTF-8 content.
   */
  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>

  /**
   * Stream the whole regular text file as decoded text chunks (same text
   * semantics as {@link readText}, for large files). The backend owns
   * cross-chunk UTF-8 decoding and binary rejection so the policy layer never
   * touches raw bytes.
   * @param target - the resolved target to read.
   * @param signal - aborts the stream, including between chunks.
   * @returns the chunk iterable, decoded and validated like {@link readText}.
   */
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>

  /**
   * Read the whole regular file as raw bytes with no decoding or binary
   * rejection. The bound lives at this seam so a backend can never buffer an
   * unbounded file: a target known or discovered to exceed `maxBytes` fails
   * with `FS_TOO_LARGE` instead of returning a truncated result.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @param maxBytes - inclusive byte cap on the complete content.
   * @returns the full raw content, at most `maxBytes` long.
   */
  abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>

  /**
   * Read one byte window of the regular file as raw bytes with no decoding or
   * binary rejection: the bytes at `[offset, offset + length)`, shorter when
   * the file ends inside the window and empty when `offset` lies at or past
   * its end. The window is the bound here, not the file: a backend transfers
   * at most `length` bytes of content beyond the prefix it skips to reach
   * `offset` and never buffers the whole file, so the caller's cap on `length`
   * is the guard against unbounded buffering.
   * @param target - the resolved target to read.
   * @param range - `offset`, the 0-based first byte, and `length`, the largest byte count; both non-negative integers.
   * @param signal - aborts the read.
   * @returns the window's bytes, at most `length` long.
   */
  abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>

  /**
   * List direct children of a directory in stable name order. Returns resolved
   * child targets plus cheap metadata only; never reads file contents.
   * @param target - the resolved directory target.
   * @param signal - aborts the listing.
   * @returns one entry per direct child, in stable name order.
   */
  abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>

  /**
   * Atomically create or replace UTF-8 text. `expected` guards intent and
   * staleness; omission allows unconditional overwrite.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root this write
   *   runs under; a sandboxing backend fences the write by it, the bare backend
   *   ignores it. Omit to leave the backend its own default.
   * @returns the outcome, including the version the write produced.
   */
  abstract writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>

  /**
   * Atomically edit literal text. When supplied, the version guard is checked
   * before matching so stale content reports `FS_STALE_VERSION`; omission edits
   * the current content without a freshness precondition.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root this edit runs
   *   under; a sandboxing backend fences the edit by it, the bare backend
   *   ignores it. Omit to leave the backend its own default.
   * @returns the outcome, including the version the edit produced.
   */
  abstract editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome>
}

export default FileSystem
