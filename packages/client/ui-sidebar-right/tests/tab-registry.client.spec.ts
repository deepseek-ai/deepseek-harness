/**
 * Stage one of tab-type registration: how the registry decides who opens an
 * address.
 *
 * The decision follows VS Code's editor resolver — declared globs narrow, an
 * optional predicate vetoes, and survivors rank by band, matched-pattern length,
 * then registration order — and every step is contract: a type shipped from
 * another package relies on each one. So each is asserted, not assumed.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import type { SidebarRightTabDefinition } from '../src/client/tab-registry.ts'
import { defaultSeed } from '../src/client/contract/seed.ts'

/** A type recognizing `patterns`, titled by its kind. */
function typeFor(
  kind: string,
  patterns: readonly string[],
  extra: Partial<Omit<SidebarRightTabDefinition, 'kind' | 'patterns'>> = {},
): SidebarRightTabDefinition {
  return { id: `test/${kind}`, kind, patterns, title: address => `${kind}:${address}`, ...extra }
}

/** Kinds of the ranked candidates, best first. */
function ranked(registry: SidebarRightTabRegistry, address: string): string[] {
  return registry.candidates(address).map(definition => definition.kind)
}

describe('SidebarRightTabRegistry — recognition', () => {
  it('rejects default-page resolution when the selected kind is not registered', () => {
    expect(() => defaultSeed(new SidebarRightTabRegistry(new Context())))
      .toThrow('default tab kind "guide" is not registered')
  })

  it('matches a pattern containing ":" against the whole address', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('guide', ['sidebar://guide']))
    registry.register(typeFor('text', ['dsh-resource://file/**']))
    expect(registry.claim('sidebar://guide').kind).toBe('guide')
    expect(registry.claim('dsh-resource://file/session/s/notes/a.txt').kind).toBe('text')
    expect(ranked(registry, 'sidebar://files')).toEqual([])
  })

  it('matches a pattern without ":" against the URI path at any depth, ignoring case', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('image', ['*.png']))
    expect(registry.claim('dsh-resource://file/session/s/deep/er/shot.PNG').kind).toBe('image')
    expect(ranked(registry, 'dsh-resource://file/session/s/shot.png.txt')).toEqual([])
  })

  it('matches no path pattern for an address that is not a URI', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('image', ['*.png']))
    registry.register(typeFor('raw', ['raw:*']))
    expect(ranked(registry, 'shot.png')).toEqual([])
    expect(ranked(registry, 'not a uri/shot.png')).toEqual([])
    // A whole-address pattern still reads the string as given.
    expect(registry.claim('raw:thing').kind).toBe('raw')
  })

  it('does not hide dotfiles from a path pattern', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('env', ['.env*']))
    expect(registry.claim('dsh-resource://file/session/s/proj/.env.local').kind).toBe('env')
  })
})

describe('SidebarRightTabRegistry — ranking', () => {
  it('ranks by band: extension over builtin over fallback, whatever the registration order', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**'], { priority: 'fallback' }))
    registry.register(typeFor('markdown', ['*.md'], { priority: 'builtin' }))
    registry.register(typeFor('third', ['*.md']))
    expect(ranked(registry, 'dsh-resource://file/session/s/a.md')).toEqual(['third', 'markdown', 'text'])
    expect(registry.claim('dsh-resource://file/session/s/a.md').kind).toBe('third')
  })

  it('lets a more specific builtin beat the fallback viewer despite the viewer\'s longer pattern', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**'], { priority: 'fallback' }))
    registry.register(typeFor('image', ['*.png'], { priority: 'builtin' }))
    expect(registry.claim('dsh-resource://file/session/s/shot.png').kind).toBe('image')
    expect(registry.claim('dsh-resource://file/session/s/notes.txt').kind).toBe('text')
  })

  it('lets an extension take over a builtin kind, and hands it back when the extension leaves', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**'], { priority: 'builtin', title: () => 'builtin text' }))
    const release = registry.register(typeFor('text', ['*.txt'], { id: 'ext/text', title: () => 'extension text' }))
    // The extension is the type in force: lookups, claims, and the listing.
    expect(registry.get('text')?.title('x')).toBe('extension text')
    expect(registry.claim('dsh-resource://file/session/s/a.txt').title).toBe('extension text')
    expect(registry.entries().map(definition => definition.title('x'))).toEqual(['extension text'])
    // The shadowed builtin's globs no longer count.
    expect(ranked(registry, 'dsh-resource://file/session/s/a.bin')).toEqual([])
    release()
    expect(registry.get('text')?.title('x')).toBe('builtin text')
    expect(registry.claim('dsh-resource://file/session/s/a.bin').title).toBe('builtin text')
  })

  it('lets a builtin register under an extension already holding its kind, shadowed until the extension leaves', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'third-party/text' }))
    const releaseBuiltin = registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'shipped/text', priority: 'builtin' }))
    expect(registry.get('text')?.id).toBe('third-party/text')
    expect(ranked(registry, 'dsh-resource://file/session/s/a.txt')).toEqual(['text'])
    // The shadowed builtin leaving changes nothing in force, and its band is free again.
    releaseBuiltin()
    expect(registry.get('text')?.id).toBe('third-party/text')
    expect(() => registry.register(typeFor('text', ['*.md'], { id: 'other/text', priority: 'builtin' }))).not.toThrow()
  })

  it('refuses a second registration in the same band, and any meeting a fallback of the kind', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'a/text', priority: 'builtin' }))
    expect(() => registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'b/text', priority: 'builtin' }))).toThrow('already registered')
    registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'c/text' }))
    expect(() => registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'd/text' }))).toThrow('already registered')
    expect(() => registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'e/text', priority: 'fallback' }))).toThrow('already registered')
    registry.register(typeFor('hex', ['dsh-resource://file/**'], { id: 'a/hex', priority: 'fallback' }))
    expect(() => registry.register(typeFor('hex', ['dsh-resource://file/**'], { id: 'b/hex', priority: 'builtin' }))).toThrow('already registered')
    expect(() => registry.register(typeFor('hex', ['dsh-resource://file/**'], { id: 'c/hex' }))).toThrow('already registered')
  })

  it('refuses a second registration of an id, whatever its kind', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    const dispose = registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'pkg/viewer', priority: 'builtin' }))
    expect(() => registry.register(typeFor('hex', ['*.bin'], { id: 'pkg/viewer' }))).toThrow('tab type id "pkg/viewer" is already registered')
    dispose()
    expect(() => registry.register(typeFor('hex', ['*.bin'], { id: 'pkg/viewer' }))).not.toThrow()
  })

  it('within a band, the longer matched pattern wins', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('markdown', ['*.md'], { priority: 'builtin' }))
    registry.register(typeFor('readme', ['README.md'], { priority: 'builtin' }))
    expect(ranked(registry, 'dsh-resource://file/session/s/proj/README.md')).toEqual(['readme', 'markdown'])
    expect(ranked(registry, 'dsh-resource://file/session/s/proj/notes.md')).toEqual(['markdown'])
  })

  it('then registration order', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('first', ['dsh-resource://file/**']))
    registry.register(typeFor('second', ['dsh-resource://file/**']))
    expect(ranked(registry, 'dsh-resource://file/session/s/a.txt')).toEqual(['first', 'second'])
  })

  it('measures specificity by the longest pattern that matched, not the longest declared', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('wide', ['*.txt', 'some/very/long/**/never.matches']))
    registry.register(typeFor('narrow', ['notes.txt']))
    expect(ranked(registry, 'dsh-resource://file/session/s/notes.txt')).toEqual(['narrow', 'wide'])
  })
})

describe('SidebarRightTabRegistry — claiming', () => {
  it('lets canOpen veto an address its globs matched', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('image', ['*.png'], { canOpen: address => address.startsWith('dsh-resource://file/') }))
    expect(registry.claim('dsh-resource://file/session/s/shot.png').kind).toBe('image')
    expect(ranked(registry, 'https://example.com/shot.png')).toEqual([])
  })

  it('opens with a named type, skipping its globs but honouring its canOpen', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**'], { canOpen: address => !address.endsWith('.bin') }))
    expect(registry.claim('sidebar://guide', 'text').kind).toBe('text')
    expect(() => registry.claim('dsh-resource://file/session/s/a.bin', 'text')).toThrow('tab type "text" refuses')
    expect(() => registry.claim('dsh-resource://file/session/s/a.txt', 'nope')).toThrow('no tab type is registered as "nope"')
  })

  it('answers with the address as contentId and the type\'s title', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**']))
    expect(registry.claim('dsh-resource://file/session/s/a.txt')).toEqual({
      kind: 'text',
      contentId: 'dsh-resource://file/session/s/a.txt',
      title: 'text:dsh-resource://file/session/s/a.txt',
    })
  })

  it('reads the title fresh, so a language change needs no re-registration', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    let language = 'zh'
    registry.register({ id: 'shipped/guide', kind: 'guide', title: () => language === 'zh' ? '开始' : 'Start' })
    expect(registry.get('guide')?.title('sidebar://guide')).toBe('开始')
    language = 'en'
    expect(registry.get('guide')?.title('sidebar://guide')).toBe('Start')
  })
})

describe('SidebarRightTabRegistry — ids and page types', () => {
  it('answers by kind with the definition in force, whose id is where its body lives', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    const disposeBuiltin = registry.register(typeFor('text', ['dsh-resource://file/**'], { id: 'shipped/text', priority: 'builtin' }))
    expect(registry.get('text')?.id).toBe('shipped/text')
    const disposeExtension = registry.register(typeFor('text', ['*.txt'], { id: 'third-party/text' }))
    expect(registry.get('text')?.id).toBe('third-party/text')
    disposeExtension()
    expect(registry.get('text')?.id).toBe('shipped/text')
    disposeBuiltin()
    expect(registry.get('text')).toBeUndefined()
  })

  it('lets a page type omit patterns: it claims no address but is found by kind, and its guide entries carry its kind', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register({
      id: 'shipped/files',
      kind: 'files',
      priority: 'builtin',
      title: () => 'Files',
      guide: [{ order: 10, title: () => 'Files' }],
    })
    expect(ranked(registry, 'dsh-resource://file/session/s/a.txt')).toEqual([])
    expect(registry.get('files')?.title('x')).toBe('Files')
    expect(registry.guide().map(entry => [entry.kind, entry.order])).toEqual([['files', 10]])
  })
})

describe('SidebarRightTabRegistry — lifetime', () => {
  it('lists registered types in registration order', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('guide', ['sidebar://guide']))
    registry.register(typeFor('text', ['dsh-resource://file/**']))
    expect(registry.entries().map(entry => entry.kind)).toEqual(['guide', 'text'])
  })

  it('refuses a second type for the same kind in the same band', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**']))
    expect(() => registry.register(typeFor('text', ['other://**'], { id: 'other/text' })))
      .toThrow('tab kind "text" is already registered')
  })

  it('drops a type when its owner disposes, and frees the kind again', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    const dispose = registry.register(typeFor('text', ['dsh-resource://file/**']))
    dispose()
    expect(registry.entries()).toEqual([])
    expect(registry.get('text')).toBeUndefined()
    expect(() => registry.register(typeFor('text', ['other://**']))).not.toThrow()
  })

  it('drops a type registered inside another plugin\'s effect when that plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new SidebarRightTabRegistry(ctx)
    const fiber = ctx.plugin({
      apply(inner: Context) {
        inner.effect(() => registry.register(typeFor('text', ['dsh-resource://file/**'])), 'test: text type')
      },
    })
    await fiber.await()
    expect(registry.get('text')).toBeDefined()
    await fiber.dispose()
    expect(registry.get('text')).toBeUndefined()
  })

  it('collects every type\'s guide entries in order, reference-stable between changes', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    const entry = (order: number) => ({ order, title: () => `#${order}` })
    registry.register(typeFor('files', [], { guide: [entry(10)] }))
    const first = registry.guide()
    expect(registry.guide()).toBe(first)
    registry.register(typeFor('artifacts', [], { guide: [entry(5)] }))
    registry.register(typeFor('text', ['dsh-resource://file/**']))
    expect(registry.guide().map(item => item.kind)).toEqual(['artifacts', 'files'])
    expect(registry.guide()).not.toBe(first)
  })

  it('notifies subscribers on registration and on disposal', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    const seen = vi.fn()
    const unsubscribe = registry.subscribe(seen)
    const dispose = registry.register(typeFor('text', ['dsh-resource://file/**']))
    expect(seen).toHaveBeenCalledTimes(1)
    dispose()
    expect(seen).toHaveBeenCalledTimes(2)
    unsubscribe()
    registry.register(typeFor('other', ['other://**']))
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('keeps entries reference-stable between changes', () => {
    const registry = new SidebarRightTabRegistry(new Context())
    registry.register(typeFor('text', ['dsh-resource://file/**']))
    const first = registry.entries()
    expect(registry.entries()).toBe(first)
    registry.register(typeFor('guide', ['sidebar://guide']))
    expect(registry.entries()).not.toBe(first)
  })
})
