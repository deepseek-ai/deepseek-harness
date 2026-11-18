import { describe, expect, it, vi } from 'vitest'
import { binaryDocumentPath, DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import { markdownDefinition, MARKDOWN_BODY_ID } from '../src/client/markdown/index.ts'
import { PLAIN_BODY_ID, textBodyDefinition } from '../src/client/text/index.ts'

function definition(id: string, overrides: Partial<DocumentPreviewDefinition> = {}): DocumentPreviewDefinition {
  return { id, title: () => id, extensions: ['md'], loading: 'text-pages', ...overrides }
}

describe('document preview implementations', () => {
  it('retains matching builtins as alternatives beneath extensions', () => {
    const registry = new DocumentPreviewRegistry()
    const builtin = definition('builtin', { priority: 'builtin' })
    const extension = definition('extension')
    registry.register(builtin)
    const dispose = registry.register(extension)
    expect(registry.candidates('/work/notes.MD')).toEqual([extension, builtin])
    dispose()
    expect(registry.candidates('/work/notes.md')).toEqual([builtin])
  })

  it('breaks same-band ties by suffix specificity and then registration order', () => {
    const registry = new DocumentPreviewRegistry()
    const short = definition('short', { extensions: ['gz'] })
    const first = definition('first', { extensions: ['tar.gz'] })
    const second = definition('second', { extensions: ['.TAR.GZ'] })
    registry.register(short)
    registry.register(first)
    registry.register(second)
    expect(registry.candidates('C:\\work\\archive.TAR.GZ')).toEqual([first, second, short])
  })

  it('does not mistake directory names or unknown suffixes for file matches', () => {
    const registry = new DocumentPreviewRegistry()
    registry.register(definition('markdown'))
    expect(registry.candidates('/work.md/plain')).toEqual([])
    expect(registry.candidates('/work/file.bin')).toEqual([])
    expect(registry.candidates('')).toEqual([])
    expect(registry.candidates('/work/.md')).toHaveLength(1)
  })

  it('keeps snapshots stable between changes and notifies after publishing', () => {
    const registry = new DocumentPreviewRegistry()
    const empty = registry.getSnapshot()
    expect(registry.getSnapshot()).toBe(empty)
    const seen: Array<readonly DocumentPreviewDefinition[]> = []
    const listener = vi.fn(() => { seen.push(registry.getSnapshot()) })
    const unsubscribe = registry.subscribe(listener)
    const entry = definition('markdown')
    const dispose = registry.register(entry)
    const registered = registry.getSnapshot()
    expect(registered).toEqual([entry])
    expect(registry.getSnapshot()).toBe(registered)
    dispose()
    dispose()
    expect(seen).toEqual([[entry], []])
    unsubscribe()
    registry.register(entry)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('marks a path binary only for declared binary suffixes, case-insensitively', () => {
    const image = definition('image', { extensions: ['png', 'svg'], binaryExtensions: ['png'] })
    const text = definition('text', { extensions: [] })
    expect(binaryDocumentPath([image, text], '/work/photo.PNG')).toBe(true)
    expect(binaryDocumentPath([image, text], 'C:\\work\\photo.png')).toBe(true)
    expect(binaryDocumentPath([image, text], '/work/diagram.svg')).toBe(false)
    expect(binaryDocumentPath([image, text], '/work.png/plain')).toBe(false)
    expect(binaryDocumentPath([text], '/work/photo.png')).toBe(false)
  })

  it('rejects a binary suffix outside the declared extensions without registering', () => {
    const registry = new DocumentPreviewRegistry()
    expect(() => registry.register(definition('image', { extensions: ['png', 'svg'], binaryExtensions: ['pdf'] })))
      .toThrow(/binary suffix "pdf" outside its extensions/u)
    expect(registry.getSnapshot()).toEqual([])
    registry.register(definition('image', { extensions: ['PNG', 'svg'], binaryExtensions: ['.png'] }))
    expect(registry.getSnapshot()).toHaveLength(1)
  })

  it('rejects duplicate ids without replacing the existing registration', () => {
    const registry = new DocumentPreviewRegistry()
    const entry = definition('markdown')
    const disposeOld = registry.register(entry)
    expect(() => registry.register(definition('markdown'))).toThrow(/duplicate implementation/u)
    expect(registry.getSnapshot()).toEqual([entry])
    disposeOld()
    const replacement = definition('markdown', { extensions: ['txt'] })
    registry.register(replacement)
    disposeOld()
    expect(registry.candidates('notes.txt')).toEqual([replacement])
  })

  it('selects media-type implementations by essence, extension band first, then registration order', () => {
    const registry = new DocumentPreviewRegistry()
    const builtin = definition('builtin', { priority: 'builtin', mediaTypes: ['text/markdown'] })
    const first = definition('first', { mediaTypes: ['Text/Markdown', 'text/x-markdown'] })
    const other = definition('other', { mediaTypes: ['text/plain'] })
    const second = definition('second', { priority: 'extension', mediaTypes: [' text/markdown ; variant=GFM'] })
    const files = definition('files')
    for (const entry of [builtin, first, other, second, files]) registry.register(entry)
    expect(registry.mediaTypeCandidates('text/markdown')).toEqual([first, second, builtin])
    expect(registry.mediaTypeCandidates('  TEXT/MARKDOWN; charset=utf-8')).toEqual([first, second, builtin])
    expect(registry.mediaTypeCandidates('text/x-markdown')).toEqual([first])
    expect(registry.mediaTypeCandidates('text/html')).toEqual([])
    // File selection keeps reading extensions only.
    expect(registry.candidates('notes.md')).toEqual([first, other, second, files, builtin])
  })

  it('rejects media types on an implementation that reads its own file without registering', () => {
    const registry = new DocumentPreviewRegistry()
    expect(() => registry.register(definition('reader', { loading: 'renderer', mediaTypes: ['text/markdown'] })))
      .toThrow(/"reader" declares media types but loads its own file content/u)
    expect(registry.getSnapshot()).toEqual([])
    registry.register(definition('reader', { loading: 'renderer' }))
    expect(registry.mediaTypeCandidates('text/markdown')).toEqual([])
  })

  it('offers the builtin Markdown and plain-text bodies for their media types', () => {
    const registry = new DocumentPreviewRegistry()
    registry.register(textBodyDefinition(() => 'Plain text'))
    registry.register(markdownDefinition(() => 'Markdown'))
    expect(registry.mediaTypeCandidates('text/markdown').map(entry => entry.id)).toEqual([MARKDOWN_BODY_ID])
    expect(registry.mediaTypeCandidates('text/plain; charset=utf-8').map(entry => entry.id)).toEqual([PLAIN_BODY_ID])
  })
})
