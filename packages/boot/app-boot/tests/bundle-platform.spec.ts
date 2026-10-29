/** Bundle declarations admit the Host operating system independently of browser clients. */
import { expect, it } from 'vitest'
import { assertBundlePlatform, UnsupportedBundlePlatformError } from '../src/bundle-platform.ts'

it.each(['darwin', 'win32', 'linux'])('allows undeclared platforms and an explicit %s Host', (platform) => {
  expect(() => { assertBundlePlatform(undefined, platform) }).not.toThrow()
  expect(() => { assertBundlePlatform([platform], platform) }).not.toThrow()
  expect(() => { assertBundlePlatform(['darwin', 'win32', 'linux'], platform) }).not.toThrow()
})

it.each(['win32', 'linux'])('rejects macOS-only bundles on %s Hosts', (platform) => {
  expect(() => { assertBundlePlatform(['darwin'], platform) }).toThrow(UnsupportedBundlePlatformError)
  expect(() => { assertBundlePlatform(['darwin'], platform) }).toThrow(`the DSH Host is running ${platform}`)
})

it.each([null, true, 'darwin', [], [1], [''], ['Darwin'], [' darwin'], ['macos'], ['darwin', 'linxu'], ['darwin', false]].map(platforms => ({ platforms })))('rejects malformed platform metadata $platforms', ({ platforms }) => {
  expect(() => { assertBundlePlatform(platforms, 'darwin') }).toThrow('dsh.bundle.platforms must be a nonempty list')
})
