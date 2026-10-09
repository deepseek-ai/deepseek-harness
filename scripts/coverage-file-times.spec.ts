import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModuleDiagnostic, ResolvedConfig } from 'vitest/node'
import { afterEach, describe, expect, it } from 'vitest'
import CoverageFileTimesReporter from './coverage-file-times.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coverage-file-times-'))
  roots.push(root)
  return root
}

describe('coverage file timing report', () => {
  it('includes import and hook costs once without serializing coverage or test objects', async () => {
    const root = await temporaryRoot()
    const reporter = new CoverageFileTimesReporter()
    reporter.onInit({ config: { root, outputFile: { fileTimes: 'times.json' } } })
    const diagnostic: ModuleDiagnostic = {
      environmentSetupDuration: 3,
      prepareDuration: 5,
      setupDuration: 7,
      collectDuration: 100,
      duration: 200,
      heap: undefined,
      // Per-dependency import times are already included in collectDuration.
      importDurations: { dependency: { selfTime: 100, totalTime: 100 } },
    }
    const module = {
      moduleId: join(root, 'packages', 'a', 'tests', 'x.spec.ts'),
      diagnostic: () => diagnostic,
      // Vitest modules retain tests and coverage through their project. The
      // timing report must read only their paths and diagnostics.
      toJSON: () => { throw new Error('test module was serialized') },
    }
    await reporter.onTestRunEnd([module])

    const output = await readFile(join(root, 'times.json'), 'utf8')
    expect(JSON.parse(output)).toEqual({ 'packages/a/tests/x.spec.ts': 315 })
    expect(output.endsWith('\n')).toBe(true)
    expect(output).not.toContain('coverageMap')
    expect(output).not.toContain('assertionResults')
  })

  it('writes an empty report when no modules finished', async () => {
    const root = await temporaryRoot()
    const reporter = new CoverageFileTimesReporter()
    reporter.onInit({ config: { root, outputFile: { fileTimes: 'times.json' } } })
    await reporter.onTestRunEnd([])
    expect(await readFile(join(root, 'times.json'), 'utf8')).toBe('{}\n')
  })

  const missingOutputs: ResolvedConfig['outputFile'][] = ['report.json', {}, { fileTimes: '' }]
  it.each(missingOutputs)(
    'rejects missing timing output %j',
    (outputFile) => {
      const reporter = new CoverageFileTimesReporter()
      expect(() => { reporter.onInit({ config: { root: '/repo', outputFile } }) })
        .toThrow('outputFile.fileTimes is required')
    },
  )
})
