/** Per-Session turn recorder: snapshots, captures around file-tool edits, the turn-end diff, and the records kept until disposal. */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { captureFile, mutationPath, sameCapture, type Capture } from './capture.ts'
import { compareText } from './compare.ts'
import {
  blobText, diffTrees, gitlinkPaths, ignoredPaths, locateGitWorkspace, snapshotTree, treeBlob, type GitRunner, type GitWorkspace,
} from './git.ts'
import { canonicalPath, compareDisplay, displayPathOf, durablePathOf, isInside, isTemporaryPath, temporaryRoots, toPosix } from './paths.ts'
import type { WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceFileDiff } from './types.ts'

/** Facts shared by every recorder of one plugin instance. */
export interface RecorderEnvironment {
  /** Resolves to the runner, or null when git is unavailable and no snapshot is taken. */
  git: Promise<GitRunner | null>
  /** Directory that receives each Session's temporary directory. */
  tempRoot: string
  /** Maximum files carried by one summary. */
  maxFiles: number
  /** Inclusive byte cap on a captured copy and on a snapshot blob read for a comparison. */
  maxFileBytes: number
  /** Milliseconds a line comparison may run before it degrades to whole-file replacement. */
  diffTimeoutMs: number
  /** Failure reporter; a failed turn records nothing and the next turn retries. */
  warn: (message: string) => void
}

/** Canonical paths every comparison and display uses, resolved once per Session. */
interface Paths {
  /** Canonical working directory; git reports symlink-resolved paths, so every comparison uses that form. */
  cwd: string
  /** Canonical home directory abbreviated as `~` in display paths. */
  home: string
  /** Temporary roots whose files outside the workspace never enter a summary. */
  temporaryRoots: readonly string[]
}

/** The repository enclosing the working directory and the runner that snapshots it. */
interface Repository {
  git: GitRunner
  workspace: GitWorkspace
}

/** The turn-start snapshot of a located repository. */
interface Baseline extends Repository { tree: string }

/** Where one readable side of a listed file's content lives. */
type ContentSource =
  /** A path in a snapshot tree; absence, size, and text are read from git when asked for. */
  | { kind: 'snapshot'; repository: Repository; tree: string; path: string }
  | Exclude<Capture, { kind: 'oversized' }>

/**
 * What a listed file's comparison is served from: a refusal decided when the
 * turn was recorded, or the two sides to read and compare when asked for.
 */
type FileSources =
  | { refusal: 'binary' | 'oversized' }
  | { refusal?: undefined; before: ContentSource; after: ContentSource }

/** A served summary with the content sources of its listed files, index-aligned with `summary.files`. */
interface TurnRecord {
  summary: WorkspaceChangesSummary
  sources: FileSources[]
}

/** Everything one turn accumulates; a new turn gets a new object so queued work for an older turn keeps its own. */
interface TurnState {
  readonly turn: number
  /**
   * The turn-start snapshot once it exists. `null` means no repository or no git, so the turn summarizes file-tool
   * captures only; `'failed'` means the repository exists but its snapshot failed, so the turn records nothing.
   */
  baseline: Baseline | null | 'failed'
  /** Content of each file-tool-mutated path before the turn's first mutation of it, by canonical absolute path. */
  readonly captures: Map<string, Capture>
  lastToolResultSeq: number
  /** Log length when the latest record attempt started; `end()` skips a turn already attempted after its last tool result. */
  attemptedAfterSeq: number
  /** Sequence of the latest appended event, or -1. */
  recordedAfterSeq: number
}

function freshState(turn: number): TurnState {
  return { turn, baseline: null, captures: new Map(), lastToolResultSeq: -1, attemptedAfterSeq: -1, recordedAfterSeq: -1 }
}

/** A listed file with the sources of its two sides. */
interface Listed { file: WorkspaceChangedFile; sources: FileSources }

/** A snapshot side larger than the byte cap. */
const OVERSIZED = Symbol('oversized')

/**
 * Serializes one Session's recording work: the turn-start snapshot, the
 * whole-file capture before each file-tool mutation, the turn-end snapshot
 * with its diff, and the appended `workspace/changes` event whose summary and
 * comparisons this recorder keeps. Snapshot objects and captured copies live in
 * a temporary directory owned by the recorder; disposal removes it together
 * with the summaries. Tool execution waits for pending work so a snapshot or
 * capture never races a mutation. A working directory outside any repository,
 * or a Host without git, gets no snapshot; its summary lists the files the file
 * tools changed.
 */
export class TurnRecorder {
  private chain: Promise<void> = Promise.resolve()
  /** The open turn; before the first `turn/start` it is an empty placeholder no event can match. */
  private state = freshState(0)
  /** Canonical paths, resolved by the first turn. */
  private paths: Paths | undefined
  /** The located repository, reused across turns once found; null keeps retrying each turn. */
  private repository: Repository | null = null
  /** Temporary directory holding this Session's snapshot objects, scratch indexes, and captured copies. */
  private scratch: Promise<string> | undefined
  /** Records by the sequence of the event that announced them. */
  private readonly records = new Map<number, TurnRecord>()
  private readonly lifetime = new AbortController()

  constructor(
    private readonly session: Session,
    private readonly cwd: string,
    private readonly env: RecorderEnvironment,
  ) {}

  /**
   * Open a turn with fresh per-turn state and queue its baseline snapshot.
   * @param turn - the turn number from `turn/start`.
   */
  start(turn: number): void {
    const state = freshState(turn)
    this.state = state
    void this.enqueue(async (signal) => {
      try {
        this.paths ??= { cwd: await realpath(this.cwd), home: await canonicalPath(homedir()), temporaryRoots: await temporaryRoots() }
        const repository = await this.locate(this.paths.cwd, signal)
        if (repository === null) return
        const tree = await snapshotTree(repository.git, repository.workspace, signal)
        state.baseline = { ...repository, tree }
      } catch (error: unknown) {
        // A repository whose snapshot failed must not be summarized as if it had none.
        state.baseline = 'failed'
        throw error
      }
    })
  }

  /**
   * Queue the capture of the path a file tool is about to mutate, before the
   * tool runs; only the turn's first mutation of a path captures it. Await
   * {@link settled} afterwards so the tool cannot overtake the capture.
   * @param name - wire tool name.
   * @param args - parsed call arguments.
   */
  capture(name: string, args: unknown): void {
    const path = mutationPath(name, args)
    if (path === undefined) return
    const state = this.state
    void this.enqueue(async () => {
      const paths = this.paths
      if (paths === undefined) return
      const absolute = await canonicalPath(resolve(paths.cwd, path))
      if (state.captures.has(absolute)) return
      const capture = await captureFile(absolute, join(await this.scratchDir(), 'captures'), this.env.maxFileBytes)
      if (capture !== undefined) state.captures.set(absolute, capture)
    })
  }

  /**
   * Remember a settled tool result, so a record after `turn/end` covers it.
   * @param event - the appended `tool/result` event.
   */
  observe(event: SessionEvent<'tool/result'>): void {
    const state = this.state
    if (event.data.turn === state.turn) state.lastToolResultSeq = event.seq
  }

  /**
   * Record the turn's changes inside the turn, before `turn/end` commits.
   * @param turn - the stopping turn.
   * @returns after the event is appended or the attempt failed.
   */
  stopping(turn: number): Promise<void> {
    const state = this.state
    if (turn !== state.turn) return Promise.resolve()
    return this.enqueue(signal => this.record(state, signal))
  }

  /**
   * Record after `turn/end` unless a record was already attempted after the turn's last tool result.
   * @param turn - the turn number from `turn/end`.
   */
  end(turn: number): void {
    const state = this.state
    if (turn !== state.turn || state.attemptedAfterSeq >= state.lastToolResultSeq) return
    void this.enqueue(signal => this.record(state, signal))
  }

  /** Resolves once every queued snapshot, capture, and record has settled. */
  settled(): Promise<void> {
    return this.chain
  }

  /**
   * The summary announced by one `workspace/changes` event of this Session.
   * @param seq - the event's sequence number.
   * @returns the summary, or undefined for a sequence this recorder did not announce.
   */
  summary(seq: number): WorkspaceChangesSummary | undefined {
    return this.records.get(seq)?.summary
  }

  /**
   * Compare one listed file's contents at turn start and turn end.
   * @param seq - the announcing event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the reads.
   * @returns the comparison, or undefined for an unknown sequence or index, or once disposed.
   * @throws when a read fails while the recorder lives.
   */
  async diff(seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined> {
    const record = this.records.get(seq)
    const file = record?.summary.files[index]
    const sources = record?.sources[index]
    if (file === undefined || sources === undefined) return undefined
    const { path, display } = file
    if (sources.refusal !== undefined) return { kind: sources.refusal, path, display }
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    try {
      const [before, after] = await Promise.all([this.readSide(sources.before, combined), this.readSide(sources.after, combined)])
      if (before === OVERSIZED || after === OVERSIZED) return { kind: 'oversized', path, display }
      const { hunks, coarse } = compareText(before, after, this.env.diffTimeoutMs)
      return { kind: 'text', path, display, before: before !== null, after: after !== null, hunks, coarse }
    } catch (error: unknown) {
      // Disposal removes the temporary directory under a running read; the Session is gone either way.
      if (this.lifetime.signal.aborted) return undefined
      throw error
    }
  }

  /**
   * Abort queued work, forget every record, and remove the temporary directory.
   * @returns once the temporary directory is gone.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.records.clear()
    await this.chain
    if (this.scratch !== undefined) await rm(await this.scratch, { recursive: true, force: true })
  }

  private enqueue(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.lifetime.signal.aborted) return
      try {
        await task(this.lifetime.signal)
      } catch (error: unknown) {
        this.warnUnlessDisposed(error)
      }
    })
    this.chain = run
    return run
  }

  /** A failure after disposal is expected cancellation and stays silent. */
  private warnUnlessDisposed(error: unknown): void {
    if (!this.lifetime.signal.aborted) this.env.warn(`workspace-changes: ${String(error)}`)
  }

  /** This Session's temporary directory, created on first use. */
  private scratchDir(): Promise<string> {
    this.scratch ??= mkdtemp(join(this.env.tempRoot, 'dsh-workspace-changes-'))
    return this.scratch
  }

  /** The repository enclosing the working directory, located once; null keeps retrying each turn. */
  private async locate(cwd: string, signal: AbortSignal): Promise<Repository | null> {
    if (this.repository !== null) return this.repository
    const git = await this.env.git
    if (git === null) return null
    const workspace = await locateGitWorkspace(git, cwd, () => this.scratchDir(), signal)
    if (workspace === null) return null
    this.repository = { git, workspace }
    return this.repository
  }

  /** One side's text, null for an absent file, or {@link OVERSIZED} for a snapshot side beyond the byte cap. */
  private async readSide(source: ContentSource, signal: AbortSignal): Promise<string | null | typeof OVERSIZED> {
    switch (source.kind) {
      case 'absent': return null
      case 'file': return readFile(source.file, { encoding: 'utf8', signal })
      case 'snapshot': {
        const { git, workspace } = source.repository
        const blob = await treeBlob(git, workspace, source.tree, source.path, signal)
        if (blob === null) return null
        if (blob.size > this.env.maxFileBytes) return OVERSIZED
        return blobText(git, workspace, blob.oid, this.env.maxFileBytes, signal)
      }
    }
  }

  private async record(state: TurnState, signal: AbortSignal): Promise<void> {
    const paths = this.paths
    const { baseline } = state
    if (paths === undefined || baseline === 'failed' || state.lastToolResultSeq < 0) return
    state.attemptedAfterSeq = state.lastToolResultSeq
    // Without a snapshot the working directory itself bounds the workspace.
    const root = baseline?.workspace.root ?? paths.cwd
    const listed = new Map<string, Listed>()
    let snapshot: WorkspaceChangesSummary['snapshot']
    if (baseline !== null) {
      const after = await snapshotTree(baseline.git, baseline.workspace, signal)
      snapshot = { before: baseline.tree, after }
      const repository: Repository = { git: baseline.git, workspace: baseline.workspace }
      for (const entry of await diffTrees(baseline.git, baseline.workspace, baseline.tree, after, signal)) {
        const absolute = resolve(root, entry.path)
        listed.set(absolute, {
          file: changedFile(paths, root, absolute, entry),
          sources: entry.binary ? { refusal: 'binary' } : {
            before: { kind: 'snapshot', repository, tree: baseline.tree, path: entry.oldPath ?? entry.path },
            after: { kind: 'snapshot', repository, tree: after, path: entry.path },
          },
        })
      }
    }
    // Captured paths the snapshots do not cover are compared from their copies.
    const captured = [...state.captures.keys()].filter(absolute => !listed.has(absolute))
    const workTreePath = (absolute: string): string => toPosix(relative(root, absolute))
    let inWorkspace = captured.filter(absolute => isInside(root, absolute))
    if (baseline !== null && inWorkspace.length > 0) {
      // Nested repositories and submodules are gitlinks: their contents never enter the summary.
      const gitlinks = await gitlinkPaths(baseline.git, baseline.workspace, signal)
      inWorkspace = inWorkspace.filter(absolute => ![...gitlinks].some(link => isInside(resolve(root, link), absolute)))
    }
    // A snapshot covers every workspace file except the ignored ones; without one, every file-tool edit counts.
    const uncoveredInWorkspace = baseline === null
      ? new Set(inWorkspace.map(workTreePath))
      : await ignoredPaths(baseline.git, baseline.workspace, inWorkspace.map(workTreePath), signal)
    for (const absolute of captured) {
      // Outside the workspace, scratch files under a temporary root stay out.
      const uncovered = isInside(root, absolute)
        ? uncoveredInWorkspace.has(workTreePath(absolute))
        : !isTemporaryPath(absolute, paths.temporaryRoots)
      if (!uncovered) continue
      const before = state.captures.get(absolute) as Capture
      const after = await captureFile(absolute, join(await this.scratchDir(), 'captures'), this.env.maxFileBytes)
      if (after === undefined || sameCapture(before, after)) continue
      listed.set(absolute, await this.compared(paths, root, absolute, before, after))
    }
    const sorted = [...listed.values()].sort((a, b) => compareDisplay(a.file, b.file))
    // An empty list after an earlier in-turn record supersedes that record.
    if (sorted.length === 0 && state.recordedAfterSeq < 0) return
    const event = this.session.append('workspace/changes', { turn: state.turn })
    const kept = sorted.slice(0, this.env.maxFiles)
    this.records.set(event.seq, {
      summary: {
        turn: state.turn,
        cwd: this.cwd,
        files: kept.map(entry => entry.file),
        total: sorted.length,
        added: sorted.reduce((sum, entry) => sum + entry.file.added, 0),
        deleted: sorted.reduce((sum, entry) => sum + entry.file.deleted, 0),
        ...snapshot === undefined ? {} : { snapshot },
      },
      sources: kept.map(entry => entry.sources),
    })
    state.recordedAfterSeq = event.seq
  }

  /**
   * The listing of a captured pair: an oversized side lists the file without
   * counts and refuses its comparison, a binary side likewise, and two text
   * sides carry the counts of their line comparison.
   */
  private async compared(paths: Paths, root: string, absolute: string, before: Capture, after: Capture): Promise<Listed> {
    const list = (counts: Counts, sources: FileSources): Listed => ({ file: changedFile(paths, root, absolute, counts), sources })
    if (before.kind === 'oversized' || after.kind === 'oversized') {
      return list({ added: 0, deleted: 0, binary: false, oversized: true }, { refusal: 'oversized' })
    }
    if (isBinary(before) || isBinary(after)) return list({ added: 0, deleted: 0, binary: true }, { refusal: 'binary' })
    const text = async (side: typeof before): Promise<string | null> => side.kind === 'file' ? readFile(side.file, 'utf8') : null
    const { added, deleted } = compareText(await text(before), await text(after), this.env.diffTimeoutMs)
    return list({ added, deleted, binary: false }, { before, after })
  }
}

/** Whether a captured side holds binary content. */
function isBinary(capture: Capture): boolean {
  return capture.kind === 'file' && capture.binary
}

interface Counts { added: number; deleted: number; binary: boolean; oversized?: boolean }

function changedFile({ cwd, home }: Paths, root: string, absolute: string, counts: Counts): WorkspaceChangedFile {
  return {
    path: durablePathOf(absolute, cwd),
    display: displayPathOf(absolute, cwd, root, home),
    added: counts.added,
    deleted: counts.deleted,
    ...counts.binary ? { binary: true as const } : {},
    ...counts.oversized === true ? { oversized: true as const } : {},
  }
}
