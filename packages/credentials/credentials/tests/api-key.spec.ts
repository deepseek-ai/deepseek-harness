import { describe, expect, it } from 'vitest'
import { normalizeApiKey, unusableApiKeyMessage } from '@deepseek-ai/dsh-credentials'

describe('normalizeApiKey', () => {
  it('accepts a printable-ASCII key unchanged', () => {
    expect(normalizeApiKey('sk-0123456789abcdef')).toEqual({ ok: true, value: 'sk-0123456789abcdef' })
  })

  it('trims surrounding whitespace before judging', () => {
    expect(normalizeApiKey('  sk-abc\t\n')).toEqual({ ok: true, value: 'sk-abc' })
  })

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a tab only', '\t'],
  ])('rejects %s as empty', (_label, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: 'empty' })
  })

  it.each([
    ['an emoji', 'sk-\u{1F600}abc'],
    ['CJK text', 'sk-你好'],
    ['full-width punctuation', 'sk-abc，'],
    ['an interior space', 'sk-abc def'],
    ['a C0 control character', 'sk-abc\x01'],
    ['a latin-1 character', 'sk-café'],
  ])('rejects %s as illegal characters', (_label, raw) => {
    expect(normalizeApiKey(raw)).toEqual({ ok: false, reason: 'illegalCharacters' })
  })

  it('accepts the printable-ASCII boundary characters', () => {
    expect(normalizeApiKey('!~')).toEqual({ ok: true, value: '!~' })
  })
})

describe('unusableApiKeyMessage', () => {
  it('names the refusing consumer and the reference of a blank key, with both ways to supply it', () => {
    expect(unusableApiKeyMessage('empty', 'llm-deepseek', 'DEEPSEEK_API_KEY')).toBe(
      'llm-deepseek: the API key resolved from DEEPSEEK_API_KEY is blank; set DEEPSEEK_API_KEY to the raw key'
      + ' (the web Models page writes it) or export it in the launching environment',
    )
  })

  it('names the refusing consumer and the reference of a key no header can carry', () => {
    expect(unusableApiKeyMessage('illegalCharacters', 'web-deepseek-api', 'ACME_API_KEY')).toBe(
      'web-deepseek-api: the API key resolved from ACME_API_KEY contains characters no HTTP header can carry;'
      + ' set ACME_API_KEY to the raw key alone (the web Models page writes it)',
    )
  })
})
