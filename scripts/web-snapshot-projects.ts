/**
 * Vitest projects of the web snapshot lane (vitest.web.config.ts).
 *
 * Project `web-serial` holds the files that rewrite the shared build output; scripts/run-web-snapshots.ts
 * runs them one at a time before the pool of every other project. Project `web` holds the remaining
 * files except the sliced ones. Vitest applies a CLI `--exclude` to the root configuration only, not to
 * `test.projects`, so the runner selects projects with `--project` instead of excluding files.
 *
 * A Vitest worker runs one file at about one CPU core, so a long browser file bounds the wall time of
 * its shard. Each file in {@link WEB_SNAPSHOT_SLICE_COUNTS} runs as `count` Vitest projects named
 * `web-slice:<file stem>:<k>`, each of which includes only that file. Every slice imports the whole
 * file and runs its file-level hooks, and `web-snapshot-slice.setup.ts` skips the tests outside slice
 * `k` before they run, which also skips their `beforeEach`/`afterEach` hooks and every `describe`
 * without a test in the slice.
 *
 * Test `i` of a file, counted depth-first in collection order from zero, belongs to slice `(i mod
 * count) + 1`. Every slice computes the assignment from the same collected test list, so the slices of
 * a file run each test exactly once. A file joins the plan only when no test reads state that an
 * earlier test of the same file creates, and when concurrent copies of its hooks share no fixed port
 * or path.
 */
import { basename } from 'node:path'

/** Files that rewrite the shared build output, in the order the CI runner runs them alone. */
export const WEB_SNAPSHOT_SERIAL_FILES: readonly string[] = [
  'apps/web/tests/hmr-live.e2e.ts',
  'apps/web/tests/client-plugin-live.e2e.ts',
  // Recorded SVG streaming retains live heartbeat assertions; reserve its browser CPU budget.
  'apps/web/tests/present-svg.e2e.ts',
]

/** Name of the project that holds {@link WEB_SNAPSHOT_SERIAL_FILES}. */
export const WEB_SNAPSHOT_SERIAL_PROJECT = 'web-serial'

/** `--project` patterns that select every project of the parallel pool. */
export const WEB_SNAPSHOT_POOL_PROJECTS: readonly string[] = ['web', 'web-slice:*']

/** One weighted shard of the parallel pool, from `DSH_WEB_SNAPSHOT_SHARD=<index>/<count>`. */
export interface WebSnapshotShard {
  readonly index: number
  readonly count: number
}

/**
 * Parse `DSH_WEB_SNAPSHOT_SHARD`.
 * @param raw - The variable's value; unset or empty selects the whole pool.
 * @returns The shard, or `undefined` for the whole pool.
 * @throws Error when the value is not `<index>/<count>` with 1 <= index <= count.
 */
export function parseWebSnapshotShard(raw: string | undefined): WebSnapshotShard | undefined {
  if (raw === undefined || raw === '') return undefined
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(raw)
  if (match === null || Number(match[1]) > Number(match[2])) {
    throw new Error(`DSH_WEB_SNAPSHOT_SHARD must be <index>/<count> with 1 <= index <= count, got ${JSON.stringify(raw)}.`)
  }
  return { index: Number(match[1]), count: Number(match[2]) }
}

/**
 * Whether a run owns {@link WEB_SNAPSHOT_SERIAL_FILES}: an unsharded run, or the last shard only, so no
 * other shard waits for them.
 * @param shard - The parsed shard, or `undefined` for the whole pool.
 * @returns `true` when the run executes the serial files.
 */
export function ownsWebSnapshotSerialFiles(shard: WebSnapshotShard | undefined): boolean {
  return shard === undefined || shard.index === shard.count
}

/** Environment variable that tells a slice project's workers which slice they run, as `<file>#<k>`. */
export const WEB_SNAPSHOT_SLICE_ENV = 'DSH_WEB_SNAPSHOT_SLICE'

/**
 * Slice count of each sliced file, keyed by its root-relative path. These files bound their shard's
 * wall time when they run whole in one worker; each count must be at least two.
 */
export const WEB_SNAPSHOT_SLICE_COUNTS: Readonly<Record<string, number>> = {
  'apps/web/tests/forge-panel.e2e.ts': 4,
  'apps/web/tests/fold-blank-matrix.e2e.ts': 3,
  'apps/web/tests/document-preview.e2e.ts': 2,
  'apps/web/tests/chat-scroll-contract.e2e.ts': 2,
}

/**
 * Name of the Vitest project that runs one slice of a file.
 * @param file - root-relative path of the sliced file.
 * @param slice - one-based slice index.
 * @returns `web-slice:<file stem>:<slice>`.
 */
export function sliceProjectName(file: string, slice: number): string {
  return `web-slice:${basename(file).replace(/\.[^.]*\.ts$/, '')}:${String(slice)}`
}

/**
 * One-based slice of a test under round-robin assignment.
 * @param index - zero-based depth-first index of the test within its file.
 * @param count - slice count of the file.
 * @returns `(index mod count) + 1`.
 */
export function sliceOfTest(index: number, count: number): number {
  return (index % count) + 1
}

/** Inline Vitest project entry; every entry extends the root configuration. */
export interface WebSnapshotProject {
  readonly extends: true
  readonly test: {
    readonly name: string
    readonly include: string[]
    readonly exclude?: string[]
    readonly env?: Record<string, string>
    readonly setupFiles?: string[]
  }
}

/**
 * Projects of the web snapshot lane.
 * @param include - globs of every web snapshot file.
 * @param defaultExclude - Vitest's default exclude globs, which a project-level `exclude` replaces.
 * @returns the serial project, the main project, and one project per slice of each sliced file.
 */
export function webSnapshotProjects(include: readonly string[], defaultExclude: readonly string[]): WebSnapshotProject[] {
  return [
    { extends: true, test: { name: WEB_SNAPSHOT_SERIAL_PROJECT, include: [...WEB_SNAPSHOT_SERIAL_FILES] } },
    { extends: true, test: { name: 'web', include: [...include], exclude: [...defaultExclude, ...WEB_SNAPSHOT_SERIAL_FILES, ...Object.keys(WEB_SNAPSHOT_SLICE_COUNTS)] } },
    ...Object.entries(WEB_SNAPSHOT_SLICE_COUNTS).flatMap(([file, count]) =>
      Array.from({ length: count }, (_, index): WebSnapshotProject => ({
        extends: true,
        test: {
          name: sliceProjectName(file, index + 1),
          include: [file],
          env: { [WEB_SNAPSHOT_SLICE_ENV]: `${file}#${String(index + 1)}` },
          setupFiles: ['./scripts/web-snapshot-slice.setup.ts'],
        },
      }))),
  ]
}
