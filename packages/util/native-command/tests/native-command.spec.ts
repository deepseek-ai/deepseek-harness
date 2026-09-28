import { describe, expect, it } from 'vitest'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'

const node = process.execPath

describe('runNativeCommand', () => {
  it('captures utf8 stdout and stderr on exit 0', async () => {
    const result = await runNativeCommand(
      node,
      ['-e', 'process.stdout.write("out✓"); process.stderr.write("err")'],
      new AbortController().signal, 'hidden',
    )
    expect(result).toEqual({ stdout: 'out✓', stderr: 'err' })
  })

  it('rejects a non-zero exit with code, stdout, and stderr attached', async () => {
    const failure = await runNativeCommand(
      node,
      ['-e', 'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(3)'],
      new AbortController().signal, 'hidden',
    ).then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 3, stdout: 'partial', stderr: 'boom' })
    expect((failure as Error).cause).toBeInstanceOf(Error)
  })

  it('rejects a missing executable with the spawn ENOENT code', async () => {
    const failure = await runNativeCommand(
      'dsh-definitely-missing-command',
      [],
      new AbortController().signal, 'hidden',
    ).then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'ENOENT' })
  })

  it('terminates the child when the signal aborts', async () => {
    const abort = new AbortController()
    const pending = runNativeCommand(node, ['-e', 'setTimeout(() => {}, 60_000)'], abort.signal, 'hidden')
    abort.abort()
    const failure = await pending.then(() => { throw new Error('unexpected resolve') }, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as { code?: unknown }).code).toBe('ABORT_ERR')
  })
})
