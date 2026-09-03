import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  cliGateOptions,
  defaultConcurrency,
  formatGateResultReason,
  gatesForMode,
  parsePidPpidLines,
  runGate,
  runGates,
  taskkillArgs,
  type Gate,
  type GateResult,
} from './run-gates.ts'

/**
 * Capture output a gate streams through runGate's streamOutput path.
 * @returns the accumulated chunks and the stdout spy to restore in finally.
 */
function captureStreamedOutput(): { writes: string[]; write: MockInstance } {
  const writes: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  return { writes, write }
}

/**
 * A process has stopped executing when its /proc entry is gone, or when it
 * lingers as a zombie ('Z') — an un-reaped but dead entry still answers
 * kill(pid, 0), so existence is not a liveness check. Non-Linux falls back to
 * kill(pid, 0), whose ESRCH means the process is gone.
 */
function procStopped(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return /\)\s+Z\s/.test(stat)
    } catch {
      return true
    }
  }
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

/**
 * Wait until the captured output contains `marker` and the grandchild pid the
 * gate printed, then return that pid.
 * @param writes - chunks captured from the gate's streamed stdout.
 * @param marker - the output line that proves the gate reached the abort point.
 * @param deadline - fail the wait when exceeded.
 * @returns the grandchild pid printed by the gate script.
 */
async function waitForGrandchildPid(writes: string[], marker: string, deadline: number): Promise<number> {
  let pid: number | undefined
  while ((pid === undefined || !writes.join('').includes(marker)) && Date.now() < deadline) {
    const match = writes.join('').match(/grandchild:(\d+)/)
    if (match !== null) pid = Number(match[1])
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  expect(pid ?? 0).toBeGreaterThan(0)
  expect(writes.join('')).toContain(marker)
  return pid!
}

/**
 * Abort the run and assert it settles marked aborted with the grandchild no
 * longer executing — the abort path must have signalled it from the captured
 * descendant list rather than settling over a live orphan.
 * @param promise - the pending `runGate` promise.
 * @param controller - the signal source to abort.
 * @param pid - the grandchild pid the gate script printed.
 */
async function abortAndExpectTreeStopped(promise: Promise<GateResult>, controller: AbortController, pid: number): Promise<void> {
  controller.abort()
  const result = await promise
  expect(result.aborted).toBe(true)
  const stopDeadline = Date.now() + 8000
  while (!procStopped(pid) && Date.now() < stopDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  expect(procStopped(pid)).toBe(true)
}


function gate(id: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: id,
    displayCommand: `run ${id}`,
    command: process.execPath,
    args: ['-e', ''],
    ...options,
  }
}

function resultFor(subject: Gate, status: GateResult['status'] = 'passed'): GateResult {
  return {
    gate: subject,
    status,
    durationMs: 10,
    output: [],
    exitCode: status === 'passed' ? 0 : 1,
    signalCode: null,
  }
}

function withPnpmEntrypoint<T>(action: () => T, entrypoint = '/private/pnpm.cjs'): T {
  const previous = process.env.npm_execpath
  process.env.npm_execpath = entrypoint
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
    else process.env.npm_execpath = previous
  }
}

function withEnv<T>(name: string, value: string | undefined, action: () => T): T {
  const previous = process.env[name]
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = previous
  }
}

describe('gate graph validation', () => {
  it.each([
    'ci-primary',
    'ci-linux-primary',
    'ci-static',
    'ci-lint-contracts-ready',
    'ci-coverage',
    'ci-snapshot',
    'ci-artifacts',
    'ci-consumers',
    'ci-windows-blocking',
    'ci-windows-complete',
    'ci-windows-observational',
    'node-compat',
    'check-all',
    'hygiene',
    'doc-sync',
    'doc-quick',
  ] as const)('constructs and executes preflight for a valid non-empty %s graph', async (mode) => {
    const subject = withPnpmEntrypoint(() => gatesForMode(mode))
    const execute = vi.fn(async (item: Gate) => resultFor(item))

    await expect(runGates(subject, subject.length, execute)).resolves.toHaveLength(subject.length)
  })

  it('keeps the public repository link policy in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('public-repository-links')
  })

  it('keeps package-group subsystem ownership in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('subsystem-pages')
  })

  it('derives the quick documentation aggregate from marked doc-sync leaves', () => {
    const full = withPnpmEntrypoint(() => gatesForMode('doc-sync'))
    const quick = withPnpmEntrypoint(() => gatesForMode('doc-quick'))

    expect(quick).toEqual(full.filter(gate => gate.quick === true))
  })

  it('keeps the hygiene aggregate aligned with the package script checks', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('hygiene').map(subject => subject.id))

    expect(ids).toEqual([
      'rescope-vendor', 'publint', 'constraints', 'package-dependencies', 'application-entrypoints',
      'dsh-package-licenses', 'package-invariants', 'built-package-invariants', 'node-next-types',
      'optional-dependency-imports', 'client-packages', 'client-ui-i18n', 'no-bare-dispatcher', 'cordis-config',
      'runtime-closure', 'vendored-links',
    ])
    expect(defaultConcurrency('hygiene', ids.length, 8)).toEqual({
      workers: 4,
      source: '8 available CPU(s), hygiene cap 4',
    })
  })

  it('schedules the longest documentation leaves before short checks', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids.slice(0, 10)).toEqual([
      'doc-typecheck', 'docs-site-build', 'doc-graphs', 'markdown-links', 'type-equivalence',
      'cordis-catalog', 'cordis-inspect-catalog', 'mermaid', 'scoped-events', 'translation-pairing',
    ])
  })

  it('launches a native pnpm entrypoint directly', () => {
    const entrypoint = String.raw`C:\Program Files\pnpm\pnpm.exe`
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-windows-blocking')[0], entrypoint)

    expect(subject).toMatchObject({
      command: entrypoint,
      args: ['run', 'build'],
    })
  })

  it.each(['ci-primary', 'ci-static', 'check-all'] as const)(
    'keeps the DSH package license policy in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('dsh-package-licenses')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all', 'hygiene'] as const)(
    'keeps package dependency enforcement in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('package-dependencies')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all'] as const)(
    'keeps the client dependency policy in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('client-packages')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all', 'hygiene'] as const)(
    'keeps hard-coded Client UI copy enforcement in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('client-ui-i18n')
    },
  )

  it.each(['ci-primary', 'ci-static', 'check-all', 'hygiene'] as const)(
    'keeps application entrypoint enforcement in %s',
    (mode) => {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

      expect(ids).toContain('application-entrypoints')
    },
  )

  it('keeps native Windows coverage blocking and behind the complete build', () => {
    const complete = withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))
    const observational = withPnpmEntrypoint(() => gatesForMode('ci-windows-observational'))
      .filter(gate => gate.id !== 'build' && gate.id !== 'docs-site-build')
    const byId = new Map(complete.map(subject => [subject.id, subject]))

    expect(byId.get('coverage')?.allowFailure).not.toBe(true)
    expect(byId.get('coverage')?.needs).toContain('build')
    expect(byId.get('coverage-exempt-heavy')?.allowFailure).not.toBe(true)
    expect(byId.get('coverage')?.needs).toContain('build')
    expect(byId.get('coverage-exempt-heavy')?.needs).toContain('build')
    expect(byId.get('coverage-exempt-heavy')?.args).toContain(
      'packages/experimental/webworker-packer/tests/image-loadable.spec.ts',
    )
    expect(observational).not.toHaveLength(0)
    for (const gate of observational) {
      const completeGate = byId.get(gate.id)
      expect(completeGate?.allowFailure).toBe(true)
      expect(completeGate?.after).toEqual(expect.arrayContaining([
        'coverage',
        'coverage-exempt-heavy',
      ]))
      expect(completeGate?.needs).toEqual(gate.needs)
    }
  })

  it('runs the Windows built-bin smoke after other observational gates settle', () => {
    const observational = withPnpmEntrypoint(() => gatesForMode('ci-windows-observational'))
    const builtBin = observational.find(gate => gate.id === 'built-bin-smoke')

    expect(builtBin?.after).toEqual(
      observational.filter(gate => gate.id !== 'built-bin-smoke').map(gate => gate.id),
    )

    const completeBuiltBin = withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))
      .find(gate => gate.id === 'built-bin-smoke')
    expect(completeBuiltBin?.after).toContain('windows-site')
    expect(completeBuiltBin?.after).not.toContain('docs-site-build')
  })

  it('applies one configured test, polling, and hook timeout to both coverage gates', () => {
    const gates = withEnv('DSH_COVERAGE_TEST_TIMEOUT_MS', '15000', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete')))

    for (const id of ['coverage', 'coverage-exempt-heavy']) {
      expect(gates.find(subject => subject.id === id)?.args).toEqual(expect.arrayContaining([
        '--testTimeout=15000',
        '--expect.poll.timeout=15000',
        '--hookTimeout=15000',
      ]))
    }
  })

  it('keeps Vitest timeout defaults when the coverage override is absent', () => {
    const gates = withEnv('DSH_COVERAGE_TEST_TIMEOUT_MS', undefined, () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete')))

    for (const id of ['coverage', 'coverage-exempt-heavy']) {
      expect(gates.find(subject => subject.id === id)?.args).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^--(?:testTimeout|expect\.poll\.timeout|hookTimeout)=/),
      ]))
    }
  })

  it('rejects an invalid coverage timeout before starting a gate', () => {
    expect(() => withEnv('DSH_COVERAGE_TEST_TIMEOUT_MS', '0', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))))
      .toThrow('DSH_COVERAGE_TEST_TIMEOUT_MS must be a positive integer')
  })

  it('selects partitioned coverage only when explicitly configured', () => {
    const coverage = withEnv('DSH_COVERAGE_PARTITIONS', '3', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete').find(subject => subject.id === 'coverage')))

    expect(coverage).toMatchObject({
      displayCommand: 'DSH_COVERAGE_PARTITIONS=3 pnpm run test:coverage:partitioned',
      args: ['/private/pnpm.cjs', 'run', 'test:coverage:partitioned'],
      env: { DSH_COVERAGE_EXEMPT_HEAVY: '1' },
      streamOutput: true,
    })
  })

  it('rejects an invalid coverage partition count before starting a gate', () => {
    expect(() => withEnv('DSH_COVERAGE_PARTITIONS', '1', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-windows-complete'))))
      .toThrow('DSH_COVERAGE_PARTITIONS must be an integer greater than 1')
  })

  it.each([
    ['empty', [], /gate graph has no gates/],
    ['duplicate ids', [gate('same'), gate('same')], /duplicate gate id "same"/],
    ['unknown dependencies', [gate('subject', { needs: ['missing'] })], /depends on unknown gate "missing"/],
    ['unknown ordering predecessors', [gate('subject', { after: ['missing'] })], /waits for unknown gate "missing"/],
    ['cycles', [gate('first', { needs: ['second'] }), gate('second', { needs: ['first'] })], /dependency cycle: first -> second -> first/],
    ['mixed cycles', [gate('first', { after: ['second'] }), gate('second', { needs: ['first'] })], /dependency cycle: first -> second -> first/],
  ] as const)('rejects %s before starting a child', async (_label, invalid, message) => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([...invalid], 1, execute)).rejects.toThrow(message)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an invalid worker count before starting a child', async () => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([gate('subject')], 0, execute)).rejects.toThrow('max concurrency must be a positive integer')
    expect(execute).not.toHaveBeenCalled()
  })

  it('skips dependents after their prerequisite fails', async () => {
    const dependent = gate('dependent', { needs: ['root'] })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, 'failed'))

    const results = await runGates([dependent, root], 1, execute)

    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(root, undefined)
    expect(results[0]).toMatchObject({ gate: dependent, status: 'skipped', error: 'dependency failed or skipped: root' })
  })

  it('runs an ordered follower after its predecessor fails', async () => {
    const follower = gate('follower', { after: ['root'] })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, subject === root ? 'failed' : 'passed'))

    const results = await runGates([follower, root], 2, execute)

    expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['root', 'follower'])
    expect(results.map(result => result.status)).toEqual(['passed', 'failed'])
  })

  it('runs an ordered follower after its predecessor is skipped', async () => {
    const follower = gate('follower', { after: ['dependent'] })
    const dependent = gate('dependent', { needs: ['root'] })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, subject === root ? 'failed' : 'passed'))

    const results = await runGates([follower, dependent, root], 2, execute)

    expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['root', 'follower'])
    expect(results.map(result => result.status)).toEqual(['passed', 'skipped', 'failed'])
  })
})

describe('Oxlint gate', () => {
  it('uses the package script when no worker bound is configured', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', undefined, () =>
      withPnpmEntrypoint(() => gatesForMode('ci-lint-contracts-ready')[0]))

    expect(subject).toMatchObject({
      id: 'lint',
      displayCommand: 'pnpm run lint:contracts-ready',
      command: process.execPath,
      args: ['/private/pnpm.cjs', 'run', 'lint:contracts-ready'],
    })
  })

  it('surfaces the configured worker bound on the shared package script', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', '4', () =>
      withPnpmEntrypoint(() => gatesForMode('ci-lint-contracts-ready')[0]))

    expect(subject).toMatchObject({
      id: 'lint',
      displayCommand: 'DSH_OXLINT_THREADS=4 pnpm run lint:contracts-ready',
      command: process.execPath,
      args: ['/private/pnpm.cjs', 'run', 'lint:contracts-ready'],
    })
  })
})

describe('Typert contract preparation', () => {
  it('prepares primary source consumers once before they run', () => {
    const subject = withEnv('DSH_OXLINT_THREADS', undefined, () =>
      withPnpmEntrypoint(() => gatesForMode('ci-primary')))

    expect(subject.find(item => item.id === 'typert-contracts')).toMatchObject({
      displayCommand: 'pnpm run build:lib:host',
      args: ['/private/pnpm.cjs', 'run', 'build:lib:host'],
    })
    for (const [id, script] of [
      ['typecheck', 'typecheck:contracts-ready'],
      ['lint', 'lint:contracts-ready'],
      ['doc-typecheck', 'doc-typecheck:contracts-ready'],
    ] as const) {
      expect(subject.find(item => item.id === id)).toMatchObject({
        displayCommand: `pnpm run ${script}`,
        args: ['/private/pnpm.cjs', 'run', script],
        needs: ['typert-contracts'],
      })
    }
    expect(subject.find(item => item.id === 'build')?.needs).toEqual([
      'typecheck',
      'lint',
      'doc-typecheck',
    ])
  })

  it('reuses contracts from the validated consumer build', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-consumers'))

    expect(subject.find(item => item.id === 'lint-and-duplication')).toMatchObject({
      displayCommand: 'pnpm run check:ci:lint:contracts-ready',
      args: ['/private/pnpm.cjs', 'run', 'check:ci:lint:contracts-ready'],
    })
    expect(subject.find(item => item.id === 'doc-typecheck')).toMatchObject({
      displayCommand: 'pnpm run doc-typecheck:contracts-ready',
      args: ['/private/pnpm.cjs', 'run', 'doc-typecheck:contracts-ready'],
    })
  })

  it('keeps standalone doc sync responsible for preparation', () => {
    const docTypecheck = withPnpmEntrypoint(() =>
      gatesForMode('doc-sync').find(item => item.id === 'doc-typecheck'))

    expect(docTypecheck?.displayCommand).toBe('pnpm run doc-typecheck')
  })
})

describe('Node compatibility graph', () => {
  it('runs the jsdom environment smoke on every advertised Node line', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('node-compat'))

    expect(subject.find(item => item.id === 'vitest-jsdom-smoke')).toMatchObject({
      label: 'Vitest jsdom smoke',
      args: [
        '/private/pnpm.cjs',
        'exec',
        'vitest',
        'run',
        'scripts/vitest-environment.compat.spec.ts',
      ],
    })
  })
})

describe('Node 24 lane ownership', () => {
  it('keeps the static lane source-only', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-static'))

    expect(subject.map(item => item.id)).not.toContain('build')
    expect(subject.map(item => item.id)).not.toContain('doc-typecheck')
  })

  it('owns the build and orders its artifact consumers', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-consumers'))

    expect(defaultConcurrency('ci-consumers', subject.length, 4)).toEqual({
      workers: 11,
      source: 'ci-consumers gate count',
    })
    expect(subject.map(item => item.id)).toEqual([
      'build',
      'node-compat',
      'publint',
      'built-package-invariants',
      'lint-and-duplication',
      'snapshot',
      'expected-output',
      'web-snapshot',
      'doc-typecheck',
      'node-next-types',
      'built-bin-smoke',
    ])
    expect(subject.find(item => item.id === 'publint')?.needs).toEqual(['build'])
    expect(subject.find(item => item.id === 'build')?.env).toEqual({
      DSH_BUILD_CLIENT_PROFILE: 'official',
    })
    expect(subject.find(item => item.id === 'node-compat')?.env).toEqual({
      DSH_BUILD_CLIENT_PROFILE: 'official',
    })
    expect(subject.find(item => item.id === 'built-package-invariants')?.needs).toEqual(['build'])
    expect(subject.find(item => item.id === 'lint-and-duplication')?.needs).toEqual(['built-package-invariants'])
    for (const id of [
      'snapshot',
      'expected-output',
      'web-snapshot',
      'doc-typecheck',
      'node-next-types',
      'built-bin-smoke',
    ]) {
      expect(subject.find(item => item.id === id)?.needs).toEqual(['built-package-invariants'])
    }
    expect(subject.find(item => item.id === 'snapshot')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'expected-output')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'doc-typecheck')?.env).toEqual({
      DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1',
    })
    expect(subject.find(item => item.id === 'built-bin-smoke')?.args).toEqual(
      expect.arrayContaining([
        'packages/subagent/subagent-codex/tests/loader-composition.e2e.ts',
        'packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts',
        'packages/experimental/agent-team/tests/built-lib.e2e.ts',
      ]),
    )
    expect(subject.find(item => item.id === 'web-snapshot')).toMatchObject({
      displayCommand: 'DSH_SNAPSHOT=replay pnpm run test:web:built',
      env: { DSH_SNAPSHOT: 'replay' },
      after: [
        'publint',
        'lint-and-duplication',
        'snapshot',
        'expected-output',
        'doc-typecheck',
        'node-next-types',
        'built-bin-smoke',
      ],
    })
  })
})

describe('Linux primary graph', () => {
  it('adds the same compare-only web gate after built client artifacts', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('ci-linux-primary'))
    const web = subject.find(item => item.id === 'web-snapshot')

    expect(web).toMatchObject({
      displayCommand: 'DSH_SNAPSHOT=replay pnpm run test:web:built',
      env: { DSH_SNAPSHOT: 'replay' },
      needs: ['built-package-invariants'],
    })
  })
})

describe('gate process outcomes', () => {
  it('streams selected gate output without retaining it', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      const result = await runGate(gate('streamed', {
        args: ['-e', "process.stdout.write('live output')"],
        streamOutput: true,
      }))

      expect(result.status).toBe('passed')
      expect(result.output).toEqual([])
      expect(write).toHaveBeenCalledWith('live output')
    } finally {
      write.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('reports signal termination independently from exit status', async () => {
    const result = await runGate(gate('terminated', {
      args: ['-e', "process.kill(process.pid, 'SIGTERM')"],
    }))

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBeNull()
    expect(result.signalCode).toBe('SIGTERM')
    expect(formatGateResultReason(result)).toBe('signal SIGTERM')
  })
})

describe('fail-fast scheduling', () => {
  it('aborts the aggregate at the first blocking failure', async () => {
    const slow = gate('slow')
    const fast = gate('fast')
    const dependent = gate('dependent', { needs: ['slow'] })
    const execute = vi.fn(async (subject: Gate, signal?: AbortSignal) => {
      if (subject.id === 'fast') {
        return new Promise<GateResult>((resolve) => {
          signal?.addEventListener('abort', () => {
            // The real runGate marks a gate the abort terminated; the drain
            // must then record it skipped rather than keep the failure.
            resolve({ ...resultFor(subject, 'failed'), aborted: true })
          }, { once: true })
        })
      }
      return resultFor(subject, subject.id === 'slow' ? 'failed' : 'passed')
    })

    const results = await runGates([slow, fast, dependent], 2, execute, () => {}, { failFast: true })

    expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['slow', 'fast'])
    expect(results.map(result => result.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(results[1]).toMatchObject({
      status: 'skipped',
      error: 'aborted by fail-fast: slow failed',
    })
    expect(results[2]).toMatchObject({
      status: 'skipped',
      error: 'aborted by fail-fast: slow failed',
    })
  })

  it('does not abort on a non-blocking gate failure', async () => {
    const observational = gate('observational', { allowFailure: true })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => (
      resultFor(subject, subject.id === 'observational' ? 'failed' : 'passed')
    ))

    const results = await runGates([observational, root], 2, execute, () => {}, { failFast: true })

    expect(execute).toHaveBeenCalledTimes(2)
    expect(results.map(result => result.status)).toEqual(['failed', 'passed'])
  })

  it('runs independent gates to completion when fail-fast is disabled', async () => {
    const root = gate('root')
    const sibling = gate('sibling')
    const execute = vi.fn(async (subject: Gate) => (
      resultFor(subject, subject.id === 'root' ? 'failed' : 'passed')
    ))

    const results = await runGates([root, sibling], 2, execute, () => {}, { failFast: false })

    expect(execute).toHaveBeenCalledTimes(2)
    expect(results.map(result => result.status)).toEqual(['failed', 'passed'])
  })

  it('kills the child when the abort signal fires', async () => {
    const controller = new AbortController()
    const promise = runGate(gate('killable', { args: ['-e', 'setInterval(() => {}, 1000)'] }), controller.signal)
    controller.abort()
    const result = await promise

    expect(result.status).toBe('failed')
    expect(result.aborted).toBe(true)
    if (process.platform !== 'win32') expect(result.signalCode).toBe('SIGTERM')
  })

  it.skipIf(process.platform === 'win32')('marks a zero-exit child as aborted when the signal fired', async () => {
    const { writes, write } = captureStreamedOutput()
    try {
      const controller = new AbortController()
      const child = gate('traps-signal', {
        args: ['-e', "process.stdout.write('ready\\n'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
        streamOutput: true,
      })
      const promise = runGate(child, controller.signal)
      // Wait for the child to register its SIGTERM trap before aborting, so
      // the signal is caught and the child really exits zero.
      const deadline = Date.now() + 5000
      while (!writes.join('').includes('ready') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      controller.abort()
      const result = await promise

      // The child trapped the signal and exited zero; the drain must not
      // report this gate passed, so the raw outcome carries the abort mark.
      expect(result.status).toBe('passed')
      expect(result.aborted).toBe(true)
    } finally {
      write.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')('kills the whole gate process tree when the abort signal fires', async () => {
    const { writes, write } = captureStreamedOutput()
    const controller = new AbortController()
    let promise: Promise<GateResult> | undefined
    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        // Detached, so the grandchild leads its own process group: the gate
        // group signal cannot reach it, and only the descendant enumeration in
        // treeKill does — the shape of a nested run-gates' leaf gates.
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true })",
        "process.stdout.write('grandchild:' + grandchild.pid + '\\n')",
        'setInterval(() => {}, 1000)',
      ].join(';')
      promise = runGate(gate('tree', { args: ['-e', script], streamOutput: true }), controller.signal)
      const deadline = Date.now() + 5000
      let pid: number | undefined
      while (pid === undefined && Date.now() < deadline) {
        const match = writes.join('').match(/grandchild:(\d+)/)
        if (match !== null) pid = Number(match[1])
        else await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(pid ?? 0).toBeGreaterThan(0)
      controller.abort()
      const result = await promise
      expect(result.status).toBe('failed')
      // The descendant enumeration signals the detached grandchild at the same
      // time as the group signal reaches the direct child; the direct child's
      // own death closes the gate pipes, so poll for the grandchild to stop
      // executing rather than asserting on a fixed instant.
      const stopDeadline = Date.now() + 5000
      while (!procStopped(pid!) && Date.now() < stopDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(procStopped(pid!)).toBe(true)
    } finally {
      // A failed wait or assertion must not leave the forever-looping detached
      // grandchild behind on the host: abort the gate and wait for the
      // process tree to settle before restoring the spy.
      controller.abort()
      await promise
      write.mockRestore()
    }
  })

  it('forwards host interruption signals to the abort path', async () => {
    const slow = gate('slow')
    const sibling = gate('sibling')
    const execute = vi.fn(async (subject: Gate, signal?: AbortSignal) => {
      if (subject.id === 'slow') {
        return new Promise<GateResult>((resolve) => {
          signal?.addEventListener('abort', () => {
            // A child can trap the signal and exit zero; the drain must still
            // record the gate skipped so the interrupted run fails.
            resolve({ ...resultFor(subject, 'passed'), aborted: true })
          }, { once: true })
        })
      }
      return resultFor(subject)
    })

    const promise = runGates([slow, sibling], 1, execute, () => {}, { failFast: true, forwardProcessSignals: true })
    // The first loop iteration starts `slow` synchronously, so its abort
    // listener is registered before the signal is emitted.
    process.emit('SIGTERM')
    const results = await promise

    expect(execute).toHaveBeenCalledOnce()
    expect(results.map(result => result.status)).toEqual(['skipped', 'skipped'])
    expect(results[0]).toMatchObject({
      status: 'skipped',
      error: 'aborted by fail-fast: host interruption',
    })
  })

  it('pairs host signal forwarding with fail-fast at the CLI entrypoint', () => {
    expect(cliGateOptions(true)).toEqual({ failFast: true, forwardProcessSignals: true })
    expect(cliGateOptions(false)).toEqual({ failFast: false, forwardProcessSignals: false })
  })

  it('rejects host signal forwarding without fail-fast', async () => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([gate('subject')], 1, execute, () => {}, { forwardProcessSignals: true }))
      .rejects.toThrow('forwardProcessSignals requires failFast')
    expect(execute).not.toHaveBeenCalled()
  })

  it('leaves an un-aborted child running to completion', async () => {
    const result = await runGate(gate('settles', { args: ['-e', ''] }), new AbortController().signal)

    expect(result.status).toBe('passed')
    expect(result.aborted).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('kills a detached descendant that outlived the child when the abort arrives later', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const controller = new AbortController()
    let promise: Promise<GateResult> | undefined
    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        // Detached with inherited stdio: the grandchild leads its own process
        // group (the gate group signal misses it) and holds the gate's
        // stdout write end (so `close` stays pending past the child exit).
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' })",
        "process.stdout.write('grandchild:' + grandchild.pid + '\\n')",
        // Outlive the first descendant-sampler tick with margin so the cache
        // holds the grandchild even on a loaded runner, then exit normally
        // before the abort arrives.
        "setTimeout(() => { process.stdout.write('child-exit\\n'); process.exit(0) }, 8000)",
      ].join(';')
      promise = runGate(gate('late-abort', { args: ['-e', script], streamOutput: true }), controller.signal)
      const pid = await waitForGrandchildPid(writes, 'child-exit', Date.now() + 10000)
      // terminate must not re-enumerate over the sampler cache now that the
      // child is gone; the detached grandchild is killed from the cached list.
      await abortAndExpectTreeStopped(promise, controller, pid)
    } finally {
      // A failed wait or assertion must not leave the forever-looping detached
      // grandchild behind on the host: abort the gate and wait for the
      // process tree to settle before restoring the spy.
      controller.abort()
      await promise
      write.mockRestore()
    }
  }, 20000)

  it.skipIf(process.platform === 'win32')('keeps a reparented detached descendant tracked across a sampler tick', async () => {
    const { writes, write } = captureStreamedOutput()
    const controller = new AbortController()
    let promise: Promise<GateResult> | undefined
    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        // Wrapper spawns a detached grandchild with inherited stdio (its own
        // process group, holding the gate's stdout write end), prints the pid,
        // then exits after 7 seconds — after the first sampler tick, before
        // the second. From then on the grandchild is reparented and
        // unreachable by parent id.
        "const wrapper = spawn(process.execPath, ['-e', \"const { spawn } = require('node:child_process'); const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' }); process.stdout.write('grandchild:' + grandchild.pid + '\\\\n'); setTimeout(() => process.exit(0), 7000)\"], { stdio: 'inherit' })",
        "wrapper.on('exit', () => process.stdout.write('wrapper-exited\\n'))",
        // Keep the root child alive past the abort with a heartbeat so the
        // test can abort while it is still running.
        "setInterval(() => process.stdout.write('hb\\n'), 1000)",
      ].join(';')
      promise = runGate(gate('sampler-merge', { args: ['-e', script], streamOutput: true }), controller.signal)
      const pid = await waitForGrandchildPid(writes, 'wrapper-exited', Date.now() + 15000)
      // Wait past the second sampler tick (t=10) with margin: a replacing tick
      // would drop the reparented grandchild from the cache, after which the
      // abort cannot reach it. The root child keeps running throughout.
      const tickDeadline = Date.now() + 10000
      const wrapperExitedAt = Date.now()
      while (Date.now() - wrapperExitedAt < 5000 && Date.now() < tickDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(Date.now() - wrapperExitedAt).toBeGreaterThanOrEqual(5000)
      await abortAndExpectTreeStopped(promise, controller, pid)
    } finally {
      // A failed wait or assertion must not leave the forever-looping detached
      // grandchild behind on the host: abort the gate and wait for the
      // process tree to settle before restoring the spy.
      controller.abort()
      await promise
      write.mockRestore()
    }
  }, 30000)
})

describe('process-table parsing', () => {
  it('parses `pid ppid` rows from a POSIX ps dump', () => {
    expect(parsePidPpidLines('  123   1\n456 123\n  789 456\n')).toEqual([[123, 1], [456, 123], [789, 456]])
  })

  it('parses Windows PowerShell Get-CimInstance output of the same shape', () => {
    expect(parsePidPpidLines(' 123 1\r\n456 123\r\n')).toEqual([[123, 1], [456, 123]])
  })

  it('drops blank and malformed lines', () => {
    expect(parsePidPpidLines('  123   1\n\ncommand not found\n999 abc\n')).toEqual([[123, 1]])
  })
})

describe('Windows tree termination', () => {
  it('targets the root first and each captured descendant after it', () => {
    expect(taskkillArgs(100, [201, 302, 403])).toEqual([
      ['/PID', '100', '/T', '/F'],
      ['/PID', '201', '/T', '/F'],
      ['/PID', '302', '/T', '/F'],
      ['/PID', '403', '/T', '/F'],
    ])
  })

  it('terminates the root alone when no descendant was captured', () => {
    expect(taskkillArgs(100, [])).toEqual([['/PID', '100', '/T', '/F']])
  })
})
