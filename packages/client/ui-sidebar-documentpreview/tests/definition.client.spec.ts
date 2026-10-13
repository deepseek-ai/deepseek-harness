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
import { parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
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
    expect(definition.patterns).toEqual(['dsh-resource://file/[\\s\\S]+'])
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
    '../AGENTS.md',
    '../../AGENTS.md',
    'dir/../AGENTS.md',
    'dir/./AGENTS.md',
    '/workspace/../AGENTS.md',
    'C:/workspace/../AGENTS.md',
    '//host/share/workspace/../AGENTS.md',
    '',
  ])('claims unresolved Session paths without rewriting their identity: %s', (path) => {
    const tabs = registry()
    const address = sessionFileAddress('s-1', path)
    expect(tabs.claim(address)).toEqual({ kind: TEXTPREVIEW_KIND, contentId: address, title: basenameOf(address) })
    expect(tabs.claim(address).contentId).toBe(address)
    expect(parseFileAddress(address)).toEqual({ scope: 'session', sessionId: 's-1', path })
  })

  it.each([
    ['./AGENTS.md', './AGENTS.md'],
    ['%2e%2E/AGENTS.md', '../AGENTS.md'],
    ['dir/%2E/AGENTS.md', 'dir/./AGENTS.md'],
    ['%252e%252e/AGENTS.md', '%2e%2e/AGENTS.md'],
    ['../a%20b%23c%3F.txt?ignored=1#section', '../a b#c?.txt'],
  ])('claims an authored address while decoding its path once: %s', (encoded, path) => {
    const tabs = registry()
    const address = `dsh-resource://file/session/s%2F1/${encoded}`
    expect(tabs.claim(address).contentId).toBe(address)
    expect(parseFileAddress(address)).toEqual({ scope: 'session', sessionId: 's/1', path })
  })

  it.each([
    'dsh-resource://file/session',
    'dsh-resource://file/session//../a.md',
    'dsh-resource://file/session/s-1',
    'dsh-resource://file/session/%/../a.md',
    'dsh-resource://file/session/s-1/../%ZZ.md',
    'DSH-RESOURCE://file/session/s-1/../a.md',
    'dsh-resource://File/session/s-1/../a.md',
  ])('keeps the Session parser veto after matching a file prefix: %s', (address) => {
    const tabs = registry()
    expect(tabs.candidates(address)).toEqual([])
    expect(() => tabs.claim(address)).toThrow('no registered tab type claims')
    expect(() => tabs.claim(address, TEXTPREVIEW_KIND)).toThrow(`tab type "${TEXTPREVIEW_KIND}" refuses`)
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

  it.each(['builtin', 'extension'] as const)('yields parent paths to the %s band and honors its veto', (priority) => {
    const tabs = registry()
    const address = sessionFileAddress('s-1', '../AGENTS.md')
    const release = tabs.register({
      id: 'test/markdown', kind: 'markdown', patterns: ['*.md'], priority, title: () => 'Markdown',
    })
    expect(tabs.candidates(address).map(type => type.kind)).toEqual(['markdown', TEXTPREVIEW_KIND])
    expect(tabs.claim(address)).toEqual({ kind: 'markdown', contentId: address, title: 'Markdown' })
    release()
    tabs.register({
      id: 'test/markdown', kind: 'markdown', patterns: ['*.md'], priority, canOpen: () => false, title: () => 'Markdown',
    })
    expect(tabs.claim(address).kind).toBe(TEXTPREVIEW_KIND)
  })

  it('ranks the file declaration by its literal length within the fallback band', () => {
    const tabs = registry()
    tabs.register({
      id: 'test/shorter', kind: 'shorter', patterns: ['dsh-resource://file/**/*.*'], priority: 'fallback', title: () => 'Shorter',
    })
    const releaseLonger = tabs.register({
      id: 'test/longer', kind: 'longer', patterns: ['dsh-resource://file/session/**/*.md'], priority: 'fallback', title: () => 'Longer',
    })
    tabs.register({ ...textDefinition(), id: 'test/tied', kind: 'tied' })
    const address = sessionFileAddress('s-1', 'AGENTS.md')
    // Specificity uses the literal pattern length, not the size of its accepted address set.
    expect(tabs.candidates(address).map(type => type.kind)).toEqual(['longer', TEXTPREVIEW_KIND, 'tied', 'shorter'])
    expect(tabs.claim(address).kind).toBe('longer')
    releaseLonger()
    expect(tabs.claim(address).kind).toBe(TEXTPREVIEW_KIND)
  })

  it('does not claim addresses of other schemes', () => {
    const tabs = registry()
    expect(() => tabs.claim('sidebar://guide')).toThrow('no registered tab type claims')
    expect(() => tabs.claim('https://example.com/a.md')).toThrow('no registered tab type claims')
  })
})
