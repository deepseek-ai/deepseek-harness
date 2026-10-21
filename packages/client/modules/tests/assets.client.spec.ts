/** Package-asset format: media types, content revisions, revisioned file names, and document-relative references. */

import { describe, expect, it } from 'vitest'
import {
  PACKAGE_ASSET_EXPORT,
  PACKAGE_ASSET_EXPORT_TARGET,
  PACKAGE_ASSET_FILES_ENTRY,
  PACKAGE_ASSET_SEGMENT,
  packageAssetMediaType,
  packageAssetReference,
  packageAssetRevision,
  packageAssetRevisionedPath,
} from '../src/assets.ts'

describe('packageAssetMediaType', () => {
  it.each([
    ['icon.svg', 'image/svg+xml'],
    ['photo.png', 'image/png'],
    ['nested/photo.webp', 'image/webp'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['PHOTO.PNG', 'image/png'],
    ['Icon.SvG', 'image/svg+xml'],
    ['archive.txt.png', 'image/png'],
    ['nested\\photo.png', 'image/png'],
    ['C:\\assets\\photo.webp', 'image/webp'],
  ])('serves %s as %s', (assetPath, mediaType) => {
    expect(packageAssetMediaType(assetPath)).toBe(mediaType)
  })

  it.each([
    ['photo', 'no extension'],
    ['.png', 'a dotfile'],
    ['nested/.png', 'a nested dotfile'],
    ['photo.png/readme', 'an extension on a parent segment only'],
    ['photo.png\\readme', 'an extension before a backslash separator'],
    ['photo.gif', 'an unsupported extension'],
    ['photo.png.txt', 'an unsupported final extension'],
    ['photo.', 'an empty extension'],
  ])('serves nothing for %s (%s)', (assetPath) => {
    expect(packageAssetMediaType(assetPath)).toBeUndefined()
  })
})

describe('packageAssetRevision', () => {
  it('keeps the first 12 hexadecimal digits of the SHA-1 content digest', () => {
    expect(packageAssetRevision(new TextEncoder().encode('abc'))).toBe('a9993e364706')
    expect(packageAssetRevision(new Uint8Array())).toBe('da39a3ee5e6b')
  })

  it('changes with the asset bytes', () => {
    expect(packageAssetRevision(Uint8Array.of(1))).not.toBe(packageAssetRevision(Uint8Array.of(2)))
  })
})

describe('packageAssetRevisionedPath', () => {
  it.each([
    ['photo.png', 'photo-a9993e364706.png'],
    ['icons/whale@2x.png', 'icons/whale@2x-a9993e364706.png'],
    ['icons/badge.zh.svg', 'icons/badge.zh-a9993e364706.svg'],
    ['icons.v2/photo', 'icons.v2/photo-a9993e364706'],
    ['icons/.png', 'icons/.png-a9993e364706'],
  ])('inserts the revision before the extension of %s', (assetPath, emitted) => {
    expect(packageAssetRevisionedPath(assetPath, 'a9993e364706')).toBe(emitted)
  })
})

describe('packageAssetReference', () => {
  it('keeps a scoped package name verbatim and encodes each path segment', () => {
    expect(packageAssetReference('@scope/pkg', 'icons/a b#?%-a9993e364706.svg'))
      .toBe('plugins/@scope/pkg/assets/icons/a%20b%23%3F%25-a9993e364706.svg')
    // Characters encodeURIComponent keeps would end an unquoted CSS url().
    expect(packageAssetReference('plain', "whale(2x)!'*-a9993e364706.png"))
      .toBe('plugins/plain/assets/whale%282x%29%21%27%2A-a9993e364706.png')
  })

  it('addresses the document-relative form of the plugin asset route without a query', () => {
    const reference = packageAssetReference('plain', 'photo-a9993e364706.png')
    expect(reference).toBe('plugins/plain/assets/photo-a9993e364706.png')
    expect(reference.startsWith(`plugins/plain/${PACKAGE_ASSET_SEGMENT}/`)).toBe(true)
  })

  it('pairs the asset export with its only accepted target and published files entry', () => {
    expect(PACKAGE_ASSET_EXPORT).toBe('./assets/*')
    expect(PACKAGE_ASSET_EXPORT_TARGET).toBe(`./${PACKAGE_ASSET_FILES_ENTRY}/*`)
  })
})
