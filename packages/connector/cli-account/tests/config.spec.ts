import { expect, it } from 'vitest'
import { CliAccountConfig } from '../src/index.ts'

it('defaults the command deadline and leaves the bin directory to the plugin', () => {
  expect(CliAccountConfig({})).toEqual({ commandTimeoutMs: 30_000 })
  expect(CliAccountConfig({ binDir: '/opt/cli/bin', commandTimeoutMs: 1 })).toEqual({ binDir: '/opt/cli/bin', commandTimeoutMs: 1 })
})

it.each([
  [{ binDir: '' }],
  [{ commandTimeoutMs: 0 }],
  [{ commandTimeoutMs: 2 ** 31 }],
])('rejects an unusable value %#', (config) => {
  expect(() => CliAccountConfig(config)).toThrow()
})
