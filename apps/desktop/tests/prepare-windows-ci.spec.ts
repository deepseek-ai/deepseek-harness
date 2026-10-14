import { describe, expect, it } from 'vitest'
import { windowsCiVersion } from '../scripts/prepare-windows-ci.mjs'

const inputs = { PACKAGE_BUILD_VERSION: 'auto', GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '2' }
const now = new Date('2026-10-09T01:02:03Z')

describe('manual Windows CI version', () => {
  it('uses the selected product prefix and UTC run identity', () => {
    expect(windowsCiVersion(inputs, '0.2.1-alpha.1', now)).toBe('0.2.1-alpha.1.20261009.42.2')
    expect(windowsCiVersion(inputs, '0.2.1', now)).toBe('0.2.1-test.20261009.42.2')
  })
  it.each(['0.2.1-alpha.1', '0.2.1-alpha.1.20261009.7'])('accepts explicit version %s without run identity', (version) => {
    expect(windowsCiVersion({ PACKAGE_BUILD_VERSION: version }, '0.2.1-alpha.1', now)).toBe(version)
  })
  it.each(['', 'bad', '0.3.0'])('reports checkout-specific guidance for %s', (version) => {
    expect(() => windowsCiVersion({ PACKAGE_BUILD_VERSION: version }, '0.2.1-alpha.1', now))
      .toThrow(/auto, 0\.2\.1-alpha\.1, or e\.g\. 0\.2\.1-alpha\.1\.20261009\.1/u)
  })
  it.each([{ GITHUB_RUN_NUMBER: '0' }, { GITHUB_RUN_ATTEMPT: '1\nINJECTED=value' }])('rejects invalid run identity %j', (override) => {
    expect(() => windowsCiVersion({ ...inputs, ...override }, '0.2.1', now)).toThrow(/positive integer/u)
  })
})


it('resolves the selected version policy independently of the update channel', () => {
  expect(windowsCiVersion({ ...inputs, PACKAGE_VERSION_MODE: 'default', DSH_PACKAGING_PRESET: 'production' }, '1.2.3', now)).toBe('1.2.3')
  expect(windowsCiVersion({ ...inputs, PACKAGE_VERSION_MODE: 'default', DSH_PACKAGING_PRESET: 'test' }, '1.2.3', now)).toBe('1.2.3-test.20261009.42.2')
  expect(windowsCiVersion({ PACKAGE_VERSION_MODE: 'product' }, '1.2.3-alpha.1', now)).toBe('1.2.3-alpha.1')
  expect(() => windowsCiVersion({ PACKAGE_VERSION_MODE: 'manual', PACKAGE_BUILD_VERSION: 'auto' }, '1.2.3', now)).toThrow(/explicit version/u)
  expect(() => windowsCiVersion({ PACKAGE_VERSION_MODE: 'invalid' }, '1.2.3', now)).toThrow(/version mode/u)
})
