import { describe, expect, it } from 'vitest'
import { normalizeRelayUrl } from '../src/host/relay-url.ts'

describe('normalizeRelayUrl', () => {
  it('keeps the path prefix and removes query, hash, and trailing slashes', () => {
    expect(normalizeRelayUrl('https://relay.example.com/team/liveshare/?a=1#x'))
      .toBe('https://relay.example.com/team/liveshare')
    expect(normalizeRelayUrl('http://127.0.0.1:37900///'))
      .toBe('http://127.0.0.1:37900')
  })

  it('rejects invalid Relay bases fail-loud', () => {
    expect(() => normalizeRelayUrl('')).toThrow(/must not be empty/u)
    expect(() => normalizeRelayUrl('/relative')).toThrow(/absolute URL/u)
    expect(() => normalizeRelayUrl('ftp://relay.example.com')).toThrow(/http or https/u)
    expect(() => normalizeRelayUrl('https://user:pass@relay.example.com')).toThrow(/credentials/u)
  })
})
