/**
 * DSH_COVERAGE_TEST_TIMEOUT_MS reaches every inline Vitest project through the
 * root config (coverageTestTimeoutOptions owns the rule and why a CLI flag
 * cannot carry it). A budget below the fixture's waits must end all three
 * inside both projects; unset must keep Vitest's defaults, under which the
 * fixture's per-test and hook waits pass and its poll ends at the 1000 ms
 * default; a malformed value must fail at config load.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COVERAGE_TEST_TIMEOUT_ENV } from './coverage-partitions.ts'

const root = resolve(import.meta.dirname, '..')
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const fixture = 'scripts/fixtures/lane-test-budget.fixture.ts'
const fixtureLine = /lane-test-budget\.fixture\.ts \((\d+) tests(?: \| (\d+) failed)?\)/g

/** One spawned Vitest run takes a few seconds; a hung child must not hold the worker. */
const CHILD_TIMEOUT_MS = 60_000

let temporaryRoot: string | undefined
let configPath = ''

// The root config with every project's inventory narrowed to the fixture, so
// the fixture never joins the ordinary inventory and still runs once per
// project. Absolute import in POSIX spelling because the temporary directory
// is outside the repository; the sibling package.json keeps Vite bundling the
// config as ESM, which the repository root's "type" otherwise supplies.
beforeAll(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-lane-test-budget-'))
  configPath = join(temporaryRoot, 'vitest.config.ts')
  writeFileSync(join(temporaryRoot, 'package.json'), '{ "type": "module" }\n', 'utf8')
  writeFileSync(configPath, [
    `import base from ${JSON.stringify(resolve(root, 'vitest.config.ts').split('\\').join('/'))}`,
    'export default {',
    '  ...base,',
    '  test: {',
    '    ...base.test,',
    '    projects: (base.test.projects ?? []).map(project => ({',
    '      ...project,',
    `      test: { ...project.test, include: [${JSON.stringify(fixture)}] },`,
    '    })),',
    '  },',
    '}',
    '',
  ].join('\n'), 'utf8')
})
afterAll(() => {
  if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true })
})

function runFixture(budget: string | undefined): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const name of Object.keys(env)) {
    // The parent worker's Vitest state and the coverage coordinator's own
    // variables describe this process, not the child; the Actions reporter
    // would otherwise annotate the parent job with the fixture's failures.
    if (name.startsWith('VITEST') || name.startsWith('DSH_COVERAGE_') || name === 'GITHUB_ACTIONS') Reflect.deleteProperty(env, name)
  }
  if (budget !== undefined) env[COVERAGE_TEST_TIMEOUT_ENV] = budget
  const child = spawnSync(process.execPath, [vitestCli, 'run', '--config', configPath], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (child.error !== undefined) throw child.error
  expect(child.signal, 'the child Vitest run ended through a signal').toBeNull()
  return { status: child.status, output: `${child.stdout}\n${child.stderr}` }
}

/** Per-project fixture summary lines, `[total, failed]` each, in output order. */
function fixtureSummaries(output: string): Array<[number, number]> {
  return [...output.matchAll(fixtureLine)].map(([, total, failed]) => [Number(total), Number(failed ?? 0)])
}

describe('lane test budget', () => {
  it('ends per-test, hook, and expect.poll waits in both inline projects', { timeout: 90_000 }, () => {
    const { status, output } = runFixture('200')

    expect(output).toMatch(/\|thread-safe\| scripts\/fixtures\/lane-test-budget\.fixture\.ts/)
    expect(output).toMatch(/\|process-bound\| scripts\/fixtures\/lane-test-budget\.fixture\.ts/)
    expect(fixtureSummaries(output)).toEqual([[3, 3], [3, 3]])
    expect(output.match(/Test timed out in 200ms\./g)).toHaveLength(2)
    expect(output.match(/Hook timed out in 200ms\./g)).toHaveLength(2)
    expect(output.match(/Matcher did not succeed in time\./g)).toHaveLength(2)
    // At most ~20 attempts fit into the 200 ms budget; the target is 10 000.
    const polled = [...output.matchAll(/expected (\d+) to be greater than 10000/g)].map(([, count]) => Number(count))
    expect(polled).toHaveLength(2)
    for (const count of polled) expect(count).toBeLessThan(100)
    expect(status).toBe(1)
  })

  it('keeps Vitest defaults when the budget is unset', { timeout: 90_000 }, () => {
    const { status, output } = runFixture(undefined)

    // 600 ms waits pass under the 5000 ms per-test and 10 000 ms hook defaults;
    // the poll case ends at the 1000 ms default and can only take longer
    // under load, never less.
    expect(fixtureSummaries(output)).toEqual([[3, 1], [3, 1]])
    expect(output.match(/Matcher did not succeed in time\./g)).toHaveLength(2)
    expect(output).not.toMatch(/Test timed out in|Hook timed out in/)
    const pollDurations = [...output.matchAll(/× expect\.poll budget (\d+)ms/g)].map(([, ms]) => Number(ms))
    expect(pollDurations).toHaveLength(2)
    for (const ms of pollDurations) expect(ms).toBeGreaterThanOrEqual(1000)
    expect(status).toBe(1)
  })

  it('refuses a malformed budget at config load before any test runs', { timeout: 90_000 }, () => {
    const { status, output } = runFixture('90000ms')

    expect(output).toContain(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer, got "90000ms".`)
    expect(fixtureSummaries(output)).toEqual([])
    expect(status).toBe(1)
  })
})
