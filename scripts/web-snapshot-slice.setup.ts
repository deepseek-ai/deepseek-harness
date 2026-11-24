/**
 * Setup file of the web snapshot slice projects (scripts/web-snapshot-projects.ts).
 *
 * Its `beforeAll` runs after Vitest collects the file and before the file's own hooks. It sets the
 * runner task mode of every test outside this worker's slice, and of every `describe` left without a
 * test in the slice, to `'skip'`, so their tests and `beforeEach`/`afterEach` hooks do not run.
 * Changing `task.mode` after collection relies on Vitest runner internals that are not public API,
 * verified on Vitest 4.1.11. A worker fails instead of running the whole file when its collected file
 * is not the planned file or when the file has fewer tests than slices.
 */
import type { RunnerTestCase, RunnerTestFile, RunnerTestSuite } from 'vitest'
import { beforeAll } from 'vitest'
import { WEB_SNAPSHOT_SLICE_COUNTS, WEB_SNAPSHOT_SLICE_ENV, sliceOfTest } from './web-snapshot-projects.ts'

const sliceMatch = /^(.+)#([1-9]\d*)$/.exec(process.env[WEB_SNAPSHOT_SLICE_ENV] ?? '')
if (sliceMatch === null) throw new Error(`${WEB_SNAPSHOT_SLICE_ENV} must be <file>#<slice>, got ${JSON.stringify(process.env[WEB_SNAPSHOT_SLICE_ENV])}.`)
const [, slicedFile = '', sliceRaw = ''] = sliceMatch
const count = WEB_SNAPSHOT_SLICE_COUNTS[slicedFile]
if (count === undefined) throw new Error(`${slicedFile} has no entry in WEB_SNAPSHOT_SLICE_COUNTS (scripts/web-snapshot-projects.ts).`)
const slice = Number(sliceRaw)

// The first argument must destructure: Vitest parses hook parameters as fixtures.
beforeAll(({}, suite) => {
  const file = suite.file
  // A file task's name is its path relative to the project root.
  const collected = file.name.replaceAll('\\', '/')
  if (collected !== slicedFile) throw new Error(`Slice project for ${slicedFile} collected ${collected}.`)
  const tests: RunnerTestCase[] = []
  const collect = (parent: RunnerTestFile | RunnerTestSuite) => {
    for (const task of parent.tasks) {
      if (task.type === 'test') tests.push(task)
      else collect(task)
    }
  }
  collect(file)
  if (tests.length < count) {
    throw new Error(`${slicedFile} has ${String(tests.length)} tests but WEB_SNAPSHOT_SLICE_COUNTS gives it ${String(count)} slices; lower its count in scripts/web-snapshot-projects.ts.`)
  }
  tests.forEach((test, index) => {
    if (sliceOfTest(index, count) !== slice) test.mode = 'skip'
  })
  const settle = (parent: RunnerTestFile | RunnerTestSuite): boolean => {
    let runs = false
    for (const task of parent.tasks) {
      const taskRuns = task.type === 'test' ? task.mode === 'run' : settle(task)
      if (task.type === 'suite' && !taskRuns && task.mode === 'run') task.mode = 'skip'
      runs ||= taskRuns
    }
    return runs
  }
  settle(file)
})
