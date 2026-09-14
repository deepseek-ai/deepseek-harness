/** Platform-independent sandbox runner diagnostics shared by enforcing consumers. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from '../src/diagnostics.ts'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-sandbox-diagnostics-'))
afterAll(() => { rmSync(spillDir, { recursive: true, force: true }) })
const RUNNER_FORMS = [['absolute', process.execPath], ['bare', 'node'], ['relative', './runner']] as const

describe('isRunnerSpawnFailure', () => {
  it.each(['EACCES', 'ENOENT'])(
    'attributes executable-class spawn code %s to argv[0] once cwd ambiguity is eliminated',
    (code) => {
      const runner = join(spillDir, 'runner')
      const error = Object.assign(new Error('spawn failed'), { code, syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, process.cwd())).toBe(true)
    },
  )

  it.each(['ENOEXEC', 'ENOTDIR', 'EPERM'])(
    'keeps unproven executable code %s ordinary despite synthetic argv[0] fields',
    (code) => {
      const runner = join(spillDir, 'runner')
      const error = Object.assign(new Error('spawn failed'), { code, syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, process.cwd())).toBe(false)
    },
  )

  it('requires a usable caller cwd before classifying absolute, bare, or relative runners', () => {
    const missingWorkdir = join(spillDir, 'missing-workdir')
    for (const [, runner] of RUNNER_FORMS) {
      const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, missingWorkdir)).toBe(false)
    }
    const fileWorkdir = join(spillDir, 'not-a-workdir')
    writeFileSync(fileWorkdir, '')
    const error = Object.assign(new Error('spawn failed'), { code: 'ENOTDIR', syscall: 'spawn node', path: 'node' })
    expect(isRunnerSpawnFailure(error, 'node', fileWorkdir)).toBe(false)
  })

  it('rejects resource, non-spawn, mismatched-program, and unstructured failures', () => {
    const missingRunner = join(spillDir, 'definitely-missing-runner')
    const spawnError = (code: unknown, syscall: unknown = `spawn ${missingRunner}`, path: unknown = missingRunner) =>
      Object.assign(new Error('spawn failed'), { code, syscall, path })
    const spawnErrorWithoutPath = (syscall: string) =>
      Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall })

    expect(isRunnerSpawnFailure(spawnError('EMFILE'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOMEM'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError(2), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'open'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 1), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', process.execPath), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', 1), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', ''), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnErrorWithoutPath('spawn'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnErrorWithoutPath('spawn other-runner'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(undefined, missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(null, missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT'), undefined, process.cwd())).toBe(false)
  })

  it('accepts only syscall and error-path facts that identify the exact runner program', () => {
    const runner = join(spillDir, 'runner with spaces')
    const spawnError = (syscall: string, path?: string) =>
      Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall, path })

    expect(isRunnerSpawnFailure(spawnError('spawn', runner), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError(`spawn ${runner}`, runner), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError(`spawn ${runner}`), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError('spawn other-runner', runner), runner, process.cwd())).toBe(false)
  })
})

describe('classifyRunnerFailure', () => {
  it('ignores empty and whitespace-only fatal signatures instead of treating exit status or notice text as evidence', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const emptyRule = [{ allowedExitCodes: [125], fatalSignatures: ['', ' ', '\t'] }]
    expect(classifyRunnerFailure(125, '', emptyRule)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice, emptyRule)).toBeUndefined()
  })

  it('keeps valid fatal signatures active beside an ignored empty entry', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const fatal = 'landlock-run: ruleset creation failed'
    const rules = [{
      allowedExitCodes: [125],
      fatalSignatures: ['', ' ', 'landlock-run: '],
      informationalLines: [notice],
    }]
    expect(classifyRunnerFailure(125, `${notice}\nchild diagnostic\n${fatal}`, rules)).toEqual({ detail: fatal })
  })

  it('requires Landlock exit 125 plus a non-notice fatal line and returns that original line', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const rules = [{ allowedExitCodes: [125], fatalSignatures: ['landlock-run: '], informationalLines: [notice] }]
    expect(classifyRunnerFailure(1, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(2, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice.toUpperCase(), rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, `${notice}: extra detail`, rules))
      .toEqual({ detail: `${notice}: extra detail` })
    expect(classifyRunnerFailure(125, `${notice}\nlandlock-run: exec failed: No such file or directory`, rules))
      .toEqual({ detail: 'landlock-run: exec failed: No such file or directory' })
  })

  it.each([
    'landlock-run: usage error: missing `-- <argv>...` command',
    'landlock-run: landlock is not enforced by this kernel (ABI unsupported or disabled)',
    'landlock-run: cannot open rule path: /gone: No such file or directory',
    'landlock-run: landlock ruleset error: Invalid argument',
    'landlock-run: exec failed: Permission denied',
    'landlock-run: out of memory',
    'landlock-run: future fatal diagnostic',
  ])('keeps known and future Landlock fatal diagnostics fail-closed: %s', (fatal) => {
    const rules = [{
      allowedExitCodes: [125],
      fatalSignatures: ['landlock-run: '],
      informationalLines: ['landlock-run: partial enforcement (older Landlock ABI)'],
    }]
    expect(classifyRunnerFailure(125, fatal, rules)).toEqual({ detail: fatal })
  })
})

describe('shared diagnostic status and matching rules', () => {
  it('ignores clean or signal exits and accepts an ungated fatal rule', () => {
    const rules = [{ fatalSignatures: ['runner failed'] }]
    expect(classifyRunnerFailure(0, 'runner failed', rules)).toBeUndefined()
    expect(classifyRunnerFailure(null, 'runner failed', rules)).toBeUndefined()
    expect(classifyRunnerFailure(1, 'ordinary text', rules)).toBeUndefined()
    expect(classifyRunnerFailure(1, 'RUNNER FAILED: detail', rules)).toEqual({ detail: 'RUNNER FAILED: detail' })
  })

  it.each([
    [null, 'Permission denied', false],
    [0, 'Permission denied', false],
    [1, 'PERMISSION DENIED', true],
    [1, 'ordinary output', false],
  ] as const)('matches selected denial signatures only on failed exits (%s,%s)', (code, stderr, expected) => {
    expect(matchesSignature(code, stderr, ['permission denied'])).toBe(expected)
  })
})
