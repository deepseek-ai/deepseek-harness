import { describe, expect, it } from 'vitest'
import { hasTypertRemoteNavigation } from './publication-payload.ts'

describe('publication payload facts', () => {
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
    expect(hasTypertRemoteNavigation({ exports: { './remote': { types: './lib/typert.remote-client.d.ts' } } })).toBe(false)
    expect(hasTypertRemoteNavigation(undefined)).toBe(false)
  })
})
