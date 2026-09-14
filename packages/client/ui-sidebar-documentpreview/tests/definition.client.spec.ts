/**
 * What the `text` type claims, and how it yields.
 *
 * The type is the fallback viewer for every Session-scoped `file` resource address, so the contract
 * worth asserting is the yielding: a narrower type registered at a higher
 * band takes its addresses, and everything else still lands here. Routing is
 * exercised through the real registry, because "fallback" means whatever the
 * registry's ranking means by it.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { TEXTPREVIEW_ID, TEXTPREVIEW_KIND, basenameOf, textDefinition } from '../src/client/definition.ts'

describe('basenameOf', () => {
  it('decodes the last segment, so an escaped name reads as itself', () => {
    expect(basenameOf('dsh-resource://file/session/s-1/work/notes/a%20b%23c.md')).toBe('a b#c.md')
  })

  it('falls back to the whole address when there is no last segment', () => {
    expect(basenameOf('dsh-resource://file/session/s-1/')).toBe('dsh-resource://file/session/s-1/')
  })

  it('keeps a malformed percent escape as it is rather than refusing the address', () => {
    expect(basenameOf('dsh-resource://file/session/s-1/work/%E0%A4%A')).toBe('%E0%A4%A')
  })
})

describe('textDefinition', () => {
  it('is the fallback claimant of every Session file address, titled by basename', () => {
    const definition = textDefinition()
    expect(definition.id).toBe(TEXTPREVIEW_ID)
    expect(definition.kind).toBe(TEXTPREVIEW_KIND)
    expect(definition.patterns).toEqual(['dsh-resource://file/**'])
    expect(definition.priority).toBe('fallback')
    expect(definition.title('dsh-resource://file/session/s-1/work/README.md')).toBe('README.md')
    // Reads require an addressed Session, even when the file path is absolute.
    expect(definition.canOpen?.('dsh-resource://file/session/s-1/work/README.md')).toBe(true)
    expect(definition.canOpen?.(sessionFileAddress('s-1', '/home/me/README.md'))).toBe(true)
    expect(definition.canOpen?.('dsh-resource://file/absolute/home/me/README.md')).toBe(false)
    expect(definition.canOpen?.('dsh-resource://file/shared/team/README.md')).toBe(false)
    expect(definition.canOpen?.('dsh-resource://file/session')).toBe(false)
  })
})

describe('text type in the registry', () => {
  function registry() {
    const tabs = new SidebarRightTabRegistry(new Context())
    tabs.register(textDefinition())
    return tabs
  }

  it('claims files of any extension, depth, and dot-prefix with relative or absolute Session paths', () => {
    const tabs = registry()
    for (const address of [
      'dsh-resource://file/session/s-1/a.md',
      'dsh-resource://file/session/s-1/deep/er/path/x.py',
      'dsh-resource://file/session/s-1/w/.env',
      'dsh-resource://file/session/s-1/w/Makefile',
      sessionFileAddress('s-1', '/home/me/notes.md'),
      sessionFileAddress('s-1', 'C:/w/x.ts'),
      sessionFileAddress('s-1', '//host/share/x.ts'),
    ]) {
      expect(tabs.claim(address)).toEqual({ kind: TEXTPREVIEW_KIND, contentId: address, title: basenameOf(address) })
    }
  })

  it.each([
    'dsh-resource://file/shared/team/notes.md',
    'dsh-resource://file/absolute/home/me/notes.md',
    'dsh-resource://file/absolute/C:/w/notes.md',
  ])('refuses a file address without a Session at claim time, named or ranked: %s', (shared) => {
    const tabs = registry()
    expect(tabs.candidates(shared)).toEqual([])
    expect(() => tabs.claim(shared)).toThrow('no registered tab type claims')
    expect(() => tabs.claim(shared, TEXTPREVIEW_KIND)).toThrow(`tab type "${TEXTPREVIEW_KIND}" refuses`)
  })

  it('yields an address to a narrower type at the extension band, and keeps the rest', () => {
    const tabs = registry()
    tabs.register({ id: 'test/image', kind: 'image', patterns: ['*.png'], priority: 'extension', title: () => 'image' })
    expect(tabs.claim('dsh-resource://file/session/s-1/w/logo.png').kind).toBe('image')
    expect(tabs.claim('dsh-resource://file/session/s-1/w/logo.md').kind).toBe(TEXTPREVIEW_KIND)
    // Still listed for the picture: a caller naming the kind may open it as text.
    expect(tabs.candidates('dsh-resource://file/session/s-1/w/logo.png').map(type => type.kind)).toEqual(['image', TEXTPREVIEW_KIND])
  })

  it('does not claim addresses of other schemes', () => {
    const tabs = registry()
    expect(() => tabs.claim('sidebar://guide')).toThrow('no registered tab type claims')
    expect(() => tabs.claim('https://example.com/a.md')).toThrow('no registered tab type claims')
  })
})
