import { describe, expect, it } from 'vitest'
import {
  negotiatePositionEncoding,
  normalizeHover,
  normalizeLocations,
  requestMethod,
  supportsOperation,
  supportsTransientOpen,
} from '@deepseek-ai/dsh-lsp-stdio'
import type { WireServerCapabilities } from '@deepseek-ai/dsh-lsp-stdio/src/protocol.ts'

const RANGE = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }

describe('requestMethod', () => {
  it('maps each operation to its textDocument request', () => {
    expect(requestMethod('goToDefinition')).toBe('textDocument/definition')
    expect(requestMethod('findReferences')).toBe('textDocument/references')
    expect(requestMethod('goToImplementation')).toBe('textDocument/implementation')
    expect(requestMethod('hover')).toBe('textDocument/hover')
  })
})

describe('supportsOperation', () => {
  it('reads the provider slot for each operation (boolean and options forms)', () => {
    const caps: WireServerCapabilities = {
      definitionProvider: true,
      referencesProvider: { workDoneProgress: true },
      implementationProvider: false,
    }
    expect(supportsOperation(caps, 'goToDefinition')).toBe(true)
    expect(supportsOperation(caps, 'findReferences')).toBe(true)
    expect(supportsOperation(caps, 'goToImplementation')).toBe(false)
    expect(supportsOperation(caps, 'hover')).toBe(false)
  })
})

describe('supportsTransientOpen', () => {
  it('accepts legacy Full and Incremental enums, rejects None and absent', () => {
    expect(supportsTransientOpen(1)).toBe(true)
    expect(supportsTransientOpen(2)).toBe(true)
    expect(supportsTransientOpen(0)).toBe(false)
    expect(supportsTransientOpen(undefined)).toBe(false)
  })

  it('accepts options with openClose:true and rejects openClose:false', () => {
    expect(supportsTransientOpen({ openClose: true })).toBe(true)
    expect(supportsTransientOpen({ openClose: false, change: 2 })).toBe(false)
  })

  it('requires an explicit openClose for the options form (no change-enum fallback)', () => {
    expect(supportsTransientOpen({ change: 1 })).toBe(false)
    expect(supportsTransientOpen({ change: 2 })).toBe(false)
    expect(supportsTransientOpen({})).toBe(false)
  })
})

describe('negotiatePositionEncoding', () => {
  it('defaults an omitted encoding to utf-16', () => {
    expect(negotiatePositionEncoding(undefined)).toBe('utf-16')
    expect(negotiatePositionEncoding('utf-16')).toBe('utf-16')
  })

  it('rejects any other encoding', () => {
    expect(() => negotiatePositionEncoding('utf-8')).toThrow(expect.objectContaining({
      name: 'LspError',
      code: 'LSP_UNSUPPORTED_ENCODING',
      message: expect.stringMatching(/unsupported position encoding "utf-8"/) as string,
    }))
  })
})

describe('normalizeLocations', () => {
  it('returns empty only for the protocol no-result value null', () => {
    expect(normalizeLocations(null)).toEqual([])
    expect(() => normalizeLocations(undefined)).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('maps a single Location', () => {
    expect(normalizeLocations({ uri: 'file:///a', range: RANGE })).toEqual([{ uri: 'file:///a', range: RANGE }])
  })

  it('maps an array of Locations', () => {
    const result = normalizeLocations([{ uri: 'file:///a', range: RANGE }, { uri: 'file:///b', range: RANGE }])
    expect(result.map(l => l.uri)).toEqual(['file:///a', 'file:///b'])
  })

  it('maps a LocationLink from targetUri + targetSelectionRange', () => {
    const link = { targetUri: 'file:///c', targetSelectionRange: RANGE, targetRange: RANGE }
    expect(normalizeLocations([link])).toEqual([{ uri: 'file:///c', range: RANGE }])
  })

  it('rejects a non-object entry', () => {
    expect(() => normalizeLocations([42])).toThrow(/non-object/)
  })

  it('rejects an entry that is neither a Location nor a LocationLink', () => {
    expect(() => normalizeLocations([{ nope: true }])).toThrow(/neither a Location nor a LocationLink/)
  })

  it('rejects a Location whose range is not an object', () => {
    expect(() => normalizeLocations([{ uri: 'file:///a', range: 'nope' }])).toThrow(/neither a Location/)
  })

  it('rejects a Location whose range positions are malformed', () => {
    expect(() => normalizeLocations([{ uri: 'file:///a', range: { start: null, end: null } }])).toThrow(/neither a Location/)
  })

  it('rejects negative and fractional position coordinates', () => {
    expect(() => normalizeLocations([{ uri: 'file:///a', range: { start: { line: -1, character: 0 }, end: RANGE.end } }]))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
    expect(() => normalizeLocations([{ uri: 'file:///a', range: { start: RANGE.start, end: { line: 1.5, character: 5 } } }]))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })
})

describe('normalizeHover', () => {
  it('returns null for null', () => {
    expect(normalizeHover(null)).toBeNull()
  })

  it('rejects a missing hover result', () => {
    expect(() => normalizeHover(undefined)).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('reads MarkupContent value and keeps a range', () => {
    expect(normalizeHover({ contents: { kind: 'markdown', value: '# H' }, range: RANGE }))
      .toEqual({ contents: '# H', range: RANGE })
  })

  it('keeps a bare string MarkedString verbatim', () => {
    expect(normalizeHover({ contents: 'plain text' })).toEqual({ contents: 'plain text' })
  })

  it('renders a language-tagged MarkedString object as a fenced code block', () => {
    expect(normalizeHover({ contents: { language: 'ts', value: 'const x = 1' } }))
      .toEqual({ contents: '```ts\nconst x = 1\n```' })
  })

  it('joins a MarkedString array with one blank line', () => {
    expect(normalizeHover({ contents: ['a', { language: 'ts', value: 'b' }] }))
      .toEqual({ contents: 'a\n\n```ts\nb\n```' })
  })

  it('drops an empty-contents hover to null', () => {
    expect(normalizeHover({ contents: { kind: 'plaintext', value: '' } })).toBeNull()
  })

  it('rejects a MarkupContent with a non-string value', () => {
    expect(() => normalizeHover({ contents: { kind: 'markdown', value: 42 } }))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('rejects a non-object payload', () => {
    expect(() => normalizeHover(42)).toThrow(/was not an object/)
  })

  it('rejects malformed contents', () => {
    expect(() => normalizeHover({ contents: { weird: true } })).toThrow(/were not MarkupContent/)
    expect(() => normalizeHover({ contents: 42 })).toThrow(/were not MarkupContent/)
  })

  it('rejects a malformed MarkedString array member', () => {
    expect(() => normalizeHover({ contents: ['ok', { language: 'ts', value: 42 }] }))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
    expect(() => normalizeHover({ contents: [null] }))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('rejects a hover with no contents field', () => {
    expect(() => normalizeHover({ range: RANGE })).toThrow(/no contents/)
  })

  it('rejects a malformed range instead of silently dropping it', () => {
    expect(() => normalizeHover({ contents: 'x', range: { start: { line: 1 } } }))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })
})
