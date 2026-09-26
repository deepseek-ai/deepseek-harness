import { expect, it } from 'vitest'
import { selectOfficeEngine } from './libreoffice-packages.mjs'

it.each([
  ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64'],
  ['win32', 'arm64', 'win32-arm64'], ['win32', 'x64', 'win32-x64'],
  ['linux', 'x64', 'wasm'], ['linux', 'arm64', 'wasm'],
  ['darwin', 'other', 'wasm'], ['freebsd', 'x64', 'wasm'],
])('selects the declared engine for %s/%s', (platform, arch, expected) => {
  const optionalDependencies = Object.fromEntries(
    ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'wasm']
      .map(engine => [`@deepseek-ai/libreoffice-kit-${engine}`, '0.0.1']),
  )
  expect(selectOfficeEngine({ optionalDependencies }, { platform, arch })).toBe(expected)
})

it('selects a declared Linux native target without an OS-specific policy change', () => {
  expect(selectOfficeEngine({ optionalDependencies: { '@deepseek-ai/libreoffice-kit-linux-x64': '1' } },
    { platform: 'linux', arch: 'x64' })).toBe('linux-x64')
})

it('uses WASM when no native targets are declared', () => {
  expect(selectOfficeEngine({}, { platform: 'darwin', arch: 'x64' })).toBe('wasm')
})
