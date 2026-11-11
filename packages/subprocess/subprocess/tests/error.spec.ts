import { describe, expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-error'
import {
  SUBPROCESS_ERROR_CODES,
  SubprocessError,
  SubprocessExecutableNotFoundError,
  subprocessSpawnFailure,
} from '../src/index.ts'

describe('SubprocessError', () => {
  it('carries a literal name and a code from the closed list', () => {
    const cause = new Error('low level')
    const error = new SubprocessError('runner failed', 'SUBPROCESS_RUNNER_FAILED', { cause })
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ name: 'SubprocessError', code: 'SUBPROCESS_RUNNER_FAILED', cause })
    expect(SUBPROCESS_ERROR_CODES).toContain(error.code)
  })

  it('keeps the executable lookup miss as its own subclass', () => {
    const error = new SubprocessExecutableNotFoundError('not on PATH')
    expect(error).toBeInstanceOf(SubprocessError)
    expect(error).toMatchObject({ name: 'SubprocessExecutableNotFoundError', code: 'SUBPROCESS_EXECUTABLE_NOT_FOUND' })
  })
})

describe('subprocessSpawnFailure', () => {
  it('classifies ENOENT and other spawn rejections, keeping the original as cause', () => {
    const missing = Object.assign(new Error('spawn pwsh ENOENT'), { code: 'ENOENT', syscall: 'spawn pwsh' })
    expect(subprocessSpawnFailure(missing, 'pwsh')).toMatchObject({
      name: 'SubprocessError',
      code: 'SUBPROCESS_SPAWN_NOT_FOUND',
      cause: missing,
      message: 'cannot start "pwsh": the program or the working directory does not exist (spawn pwsh ENOENT)',
    })
    const denied = Object.assign(new Error('spawn bash EACCES'), { code: 'EACCES' })
    expect(subprocessSpawnFailure(denied, 'bash')).toMatchObject({ code: 'SUBPROCESS_SPAWN_FAILED', cause: denied })
  })

  it('returns values without an errno code unchanged', () => {
    const internal = new Error('subprocess implementation dropped a requested collect stream')
    expect(subprocessSpawnFailure(internal, 'bash')).toBe(internal)
    const numeric = Object.assign(new Error('exit'), { code: 1 })
    expect(subprocessSpawnFailure(numeric, 'bash')).toBe(numeric)
    expect(subprocessSpawnFailure('raw', 'bash')).toBe('raw')
  })

  it('returns coded errors and cancellations unchanged', () => {
    const coded = new HarnessError('sandbox unavailable', 'SANDBOX_UNAVAILABLE')
    expect(subprocessSpawnFailure(coded, 'bash')).toBe(coded)
    const abort = new DOMException('aborted', 'AbortError')
    expect(subprocessSpawnFailure(abort, 'bash')).toBe(abort)
  })
})
