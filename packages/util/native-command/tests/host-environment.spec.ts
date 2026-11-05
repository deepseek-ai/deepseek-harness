/** Environment classification keeps Windows processes distinct from WSL and ordinary Linux. */
import { expect, it } from 'vitest'
import { isWsl } from '../src/host-environment.ts'

it.each([
  ['win32', { WSL_DISTRO_NAME: 'Ubuntu' }, 'microsoft', false],
  ['darwin', { WSL_INTEROP: '/run/WSL/1_interop' }, 'Darwin', false],
  ['linux', { WSL_DISTRO_NAME: 'Ubuntu' }, 'generic', true],
  ['linux', { WSL_INTEROP: '/run/WSL/1_interop' }, 'generic', true],
  ['linux', {}, '5.15.153.1-microsoft-standard-WSL2', true],
  ['linux', {}, '4.4.0-19041-Microsoft', true],
  ['linux', { WSL_DISTRO_NAME: '', WSL_INTEROP: '' }, '6.8.0-generic', false],
])('classifies %s with %j and %s', (platform, env, osRelease, expected) => {
  expect(isWsl({ platform, env, osRelease })).toBe(expected)
})

it('uses the current Node platform when only WSL markers are supplied', () => {
  expect(isWsl({ env: { WSL_DISTRO_NAME: 'Ubuntu' }, osRelease: 'generic' })).toBe(process.platform === 'linux')
})
