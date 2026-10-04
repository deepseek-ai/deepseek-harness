/**
 * Contract of the Web bundle's advertised-root parser: a canonical HTTP(S)
 * root with an optional mount prefix, normalized to a trailing slash. The
 * rejections pin the hazards WHATWG URL parsing accepts on its own.
 */

import { describe, expect, it } from 'vitest'
import { parsePublicUrl } from '../src/public-url.ts'

describe('parsePublicUrl', () => {
  it('accepts canonical HTTP(S) roots and normalizes a missing trailing slash', () => {
    expect(parsePublicUrl('https://app.example').href).toBe('https://app.example/')
    expect(parsePublicUrl('https://app.example/ui').href).toBe('https://app.example/ui/')
    expect(parsePublicUrl('https://app.example:8443/ui').href).toBe('https://app.example:8443/ui/')
    expect(parsePublicUrl('https://[::1]:8443/ui').href).toBe('https://[::1]:8443/ui/')
    expect(parsePublicUrl('HTTPS://app.example/UI').href).toBe('https://app.example/UI/')
  })



  it.each([
    // One row per rejection branch; the whitespace check precedes the scheme check.
    ['relative or non-HTTP(S)', '/web/ui', 'publicUrl must be an absolute http or https URL of the form'],
    ['whitespace or control', 'https://app.example/ui ', 'publicUrl must not contain ASCII whitespace or control characters'],
    ['query or fragment', 'https://app.example/ui?x=1', 'publicUrl must not include a query or fragment'],
    ['host-less', 'https:///ui', 'publicUrl must name a host after http:// or https://'],
    ['credential-bearing', 'https://user@example.com/', 'publicUrl must not include credentials'],
    ['unparseable', 'https://[broken/', /^publicUrl must be an absolute http or https URL$/u],
  ] as const)('rejects a %s publicUrl', (_kind, value, message) => {
    expect(() => parsePublicUrl(value)).toThrow(message)
  })
})
