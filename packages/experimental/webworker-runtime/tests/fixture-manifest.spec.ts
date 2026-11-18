import { describe, expect, it } from 'vitest'
import {
  parsePreviewFixtureManifest, PREVIEW_FIXTURE_MANIFEST_VERSION,
} from '../src/fixture-manifest.ts'

describe('Preview fixture manifest', () => {
  it('accepts a unique named fixture with ordered overlays', () => {
    expect(parsePreviewFixtureManifest({
      version: PREVIEW_FIXTURE_MANIFEST_VERSION,
      defaultFixture: 'example',
      fixtures: [{
        id: 'example',
        label: 'Example',
        description: 'A deterministic example.',
        overlays: ['fixtures/base.tar.gz', 'fixtures/tail.tar.gz'],
      }],
    })).toEqual({
      version: PREVIEW_FIXTURE_MANIFEST_VERSION,
      defaultFixture: 'example',
      fixtures: [{
        id: 'example',
        label: 'Example',
        description: 'A deterministic example.',
        overlays: ['fixtures/base.tar.gz', 'fixtures/tail.tar.gz'],
      }],
      links: [],
    })
  })

  it('accepts relative links', () => {
    const links = [{ label: 'Snapshot changes', href: '../snapshot-diff/' }, { label: 'Root', href: '/report/' }]
    expect(parsePreviewFixtureManifest({ version: 1, defaultFixture: null, fixtures: [], links }).links).toEqual(links)
  })

  it.each(['https://example.test/', 'javascript:alert(1)', '//example.test/', '\\\\example.test/', '', ' //evil.test/x', '/\t/evil.test/x', '\njavascript:alert(1)'])('rejects the link href %j', (href) => {
    expect(() => parsePreviewFixtureManifest({ version: 1, defaultFixture: null, fixtures: [], links: [{ label: 'L', href }] }))
      .toThrow(/invalid link/)
  })

  it.each([
    [{ version: 2, defaultFixture: null, fixtures: [] }, /must use version/],
    [{ version: 1, defaultFixture: 'missing', fixtures: [] }, /defaultFixture/],
    [{
      version: 1,
      defaultFixture: 'duplicate',
      fixtures: [
        { id: 'duplicate', label: 'One', description: 'First.', overlays: ['one.tar.gz'] },
        { id: 'duplicate', label: 'Two', description: 'Second.', overlays: ['two.tar.gz'] },
      ],
    }, /repeats id/],
    [{
      version: 1,
      defaultFixture: 'none',
      fixtures: [{ id: 'none', label: 'None', description: 'Reserved.', overlays: ['none.tar.gz'] }],
    }, /invalid fixture entry/],
    [{ version: 1, defaultFixture: null, fixtures: [], links: {} }, /links must be an array/],
    [{ version: 1, defaultFixture: null, fixtures: [], links: [{ label: '', href: 'a/' }] }, /invalid link/],
  ])('rejects malformed catalogs', (value, error) => {
    expect(() => parsePreviewFixtureManifest(value)).toThrow(error)
  })
})
