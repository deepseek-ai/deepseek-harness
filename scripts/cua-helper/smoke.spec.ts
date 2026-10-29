/** Native smoke failures must expose the captured launch error in CI logs. */
import { execa } from 'execa'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('retains native startup and timeout diagnostics', async ({ signal }) => {
  const result = await execa('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/cua-helper', '-p', 'test_smoke.py'], {
    cancelSignal: signal, killDescendants: true, reject: false,
  })
  expect(result.isCanceled).toBe(false)
  expect(result.signal).toBeUndefined()
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stderr).toMatch(/Ran [1-9]\d* tests?\b/)
})
