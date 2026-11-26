import { expect, it } from 'vitest'
import { selectOfficeEngine } from './libreoffice-packages.mjs'

it.each([
  ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64'],
  ['win32', 'arm64', 'win32-arm64'], ['win32', 'x64', 'win32-x64'],
  ['linux', 'x64', 'linux-x64-glibc'], ['linux', 'arm64', 'linux-arm64-glibc'],
])('selects the declared native engine for %s/%s', (platform, arch, expected) => {
  const optionalDependencies = Object.fromEntries(
    ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-x64-glibc', 'linux-arm64-glibc']
      .map(engine => [`@deepseek-ai/libreoffice-kit-${engine}`, '0.0.1']),
  )
  expect(selectOfficeEngine({ optionalDependencies }, { platform, arch })).toBe(expected)
})

it('rejects a Linux target whose glibc engine the kit does not declare', () => {
  expect(() => selectOfficeEngine({ optionalDependencies: { '@deepseek-ai/libreoffice-kit-linux-x64': '1' } },
    { platform: 'linux', arch: 'x64' })).toThrow('Office engine @deepseek-ai/libreoffice-kit-linux-x64-glibc is not declared for linux/x64.')
  expect(() => selectOfficeEngine({ optionalDependencies: { '@deepseek-ai/libreoffice-kit-linux-x64-glibc': '1' } },
    { platform: 'linux', arch: 'arm64' })).toThrow('Office engine @deepseek-ai/libreoffice-kit-linux-arm64-glibc is not declared for linux/arm64.')
})

it('rejects targets without a declared native engine even when WASM is declared', () => {
  const optionalDependencies = { '@deepseek-ai/libreoffice-kit-wasm': '0.0.1' }
  expect(() => selectOfficeEngine({ optionalDependencies }, { platform: 'freebsd', arch: 'x64' }))
    .toThrow('Office engine @deepseek-ai/libreoffice-kit-freebsd-x64 is not declared for freebsd/x64.')
  expect(() => selectOfficeEngine({}, { platform: 'darwin', arch: 'x64' }))
    .toThrow('Office engine @deepseek-ai/libreoffice-kit-darwin-x64 is not declared for darwin/x64.')
})
