import { describe, expect, it } from 'vitest'
import {
  hasTypertRemoteNavigation,
  isForbiddenPublicationFile,
  validateTarballPayload,
} from './publication-payload.ts'

function validateFixtureTarball(files: readonly string[]): () => void {
  return () => {
    validateTarballPayload(files, 'fixture.tgz')
  }
}

describe('publication payload policy', () => {
  it.each([
    'lib/index.js',
    'lib/types/index.d.ts',
    'lib/types/index.d.ts.map',
    'lib/typert.remote-client.d.ts.map',
    'lib/styles/base.css',
    'src',
    './src',
    'src/',
    'src/index.ts',
    './src/index.ts',
    String.raw`src\index.ts`,
  ])('accepts %s', (file) => {
    expect(isForbiddenPublicationFile(file)).toBe(false)
  })

  it.each([
    'lib/client.js.map',
    './lib/client.js.map',
    'lib/types/index.js.map',
    String.raw`lib\client.js.map`,
  ])('rejects static manifest path %s', (file) => {
    expect(isForbiddenPublicationFile(file)).toBe(true)
  })

  it('rejects bundled JavaScript maps in packed tarballs', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/lib/client.js.map',
    ])).toThrow('fixture.tgz publishes JavaScript map package/lib/client.js.map')
  })

  it('accepts source, declaration maps, and declarations in packed tarballs', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/src/index.ts',
      'package/lib/types/index.d.ts',
      'package/lib/types/index.d.ts.map',
      'package/lib/typert.remote-client.d.ts.map',
    ])).not.toThrow()
  })

  it('accepts a clean packed tarball', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/lib/index.js',
      'package/lib/types/index.d.ts',
      'package/lib/styles/base.css',
    ])).not.toThrow()
  })

  it('recognizes only the canonical Host-for-Client export pair', () => {
    expect(hasTypertRemoteNavigation({
      exports: {
        './remote': {
          types: './lib/typert.remote-client.d.ts',
          default: './lib/typert.remote-client.js',
        },
      },
    })).toBe(true)
    expect(hasTypertRemoteNavigation({ exports: { './remote': './lib/remote.js' } })).toBe(false)
  })
})
