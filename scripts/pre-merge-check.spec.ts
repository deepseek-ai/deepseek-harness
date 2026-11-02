import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkMode, failureDecision, preMergeCheck, preMergeSteps, type PreMergeStep } from './pre-merge-check.ts'

/**
 * Steps that exit with the given codes, so the check runs without pnpm.
 * @param codes - Exit code of each step, in order.
 * @returns The steps.
 */
function steps(codes: readonly number[]): PreMergeStep[] {
  return codes.map((code, index) => ({ name: `step-${index}`, command: process.execPath, args: ['-e', `process.exit(${code})`] }))
}

describe('pre-merge check', () => {
  it('runs every step in order and passes when they all succeed', async () => {
    const lines: string[] = []
    const outcome = await preMergeCheck(process.cwd(), { steps: steps([0, 0, 0]), report: line => void lines.push(line) })
    expect(outcome).toEqual({ ok: true })
    expect(lines).toEqual(['pre-merge-check: running step-0', 'pre-merge-check: running step-1', 'pre-merge-check: running step-2'])
  })

  it('stops at the first step that fails', async () => {
    const lines: string[] = []
    const outcome = await preMergeCheck(process.cwd(), { steps: steps([1, 0]), report: line => void lines.push(line) })
    expect(outcome).toEqual({ ok: false, reason: 'the step-0 step failed' })
    expect(lines).not.toContain('pre-merge-check: running step-1')
  })

  it('reports a command that cannot start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pre-merge-'))
    try {
      const outcome = await preMergeCheck(root, {
        steps: [{ name: 'missing', command: join(root, 'no-such-command'), args: [] }],
        report: () => {},
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toContain('cannot run')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks the versions before it installs, and installs before the builds', () => {
    const steps = preMergeSteps('/repo')
    expect(steps.map(step => step.name)).toEqual(['versions', 'install', 'host contracts', 'client'])
    expect(steps[0]).toEqual({ name: 'versions', command: process.execPath, args: [join('/repo', 'scripts', 'verify-version-sync.ts'), '/repo'] })
    expect(steps[1]).toEqual({ name: 'install', command: 'pnpm', args: ['install', '--frozen-lockfile'] })
    expect(steps[3]?.args).toEqual(['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'client'])
  })

  it('annotates a failure as a warning and passes in report mode', () => {
    expect(checkMode('report')).toBe('report')
    expect(checkMode('block')).toBe('block')
    expect(checkMode('off')).toBe('off')
    expect(checkMode('nonsense')).toBe('report')
    expect(checkMode(undefined)).toBe('report')
    expect(checkMode('')).toBe('report')
    expect(failureDecision('report', 'the install step failed')).toEqual({
      line: '::warning title=Pre-Merge Check::the merged tree fails its pre-merge check: the install step failed',
      exitCode: 0,
    })
    expect(failureDecision('block', 'the install step failed')).toEqual({
      line: '::error title=Pre-Merge Check::the merged tree fails its pre-merge check: the install step failed',
      exitCode: 1,
    })
    expect(failureDecision('off', 'the client step failed').exitCode).toBe(0)
  })
})
