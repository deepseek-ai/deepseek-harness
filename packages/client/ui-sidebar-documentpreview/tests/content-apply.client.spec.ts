/**
 * The `content` registrations against the real tab registry, renderer registry,
 * and document tab retention: the content tab type and its title, content passed
 * as navigation input under explicit or fresh keys, per-tab view state forgotten
 * when its tab record ends, and the removal of every registration when the
 * plugin goes. Slots and copy are recorders.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { ContentPreviewInjected } from '../src/client/content/face.ts'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import { Context } from '@deepseek-ai/cordis'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { apply } from '../src/client/content/index.ts'
import { retainDocumentTabs } from '../src/client/document/tab-lifetime.ts'
import { ContentPreview } from '../src/client/content/ContentPreview.tsx'
import { ContentTitle } from '../src/client/content/ContentTitle.tsx'
import { CONTENTPREVIEW_ID } from '../src/client/content/index.ts'
import type { ContentPreviewStore } from '../src/client/content/store.ts'

/** The services the content registrations read. */
const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'resources', 'documentPreviews']

interface Recorded {
  name: string
  key: string
  locale?: string
  store?: ContentPreviewStore
  inject?: (...args: never[]) => unknown
  children?: Record<string, unknown>
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const resources = new ResourceRegistry(ctx)
  const tabs = new SidebarRightTabRegistry(ctx)
  const previews = new DocumentPreviewRegistry()
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const locale = { bind: vi.fn(() => (key: string) => `t:${key}`) }
  const openResource = vi.fn<Context['sidebarRight']['openResource']>()
  ctx.provide('sidebarRight', { openResource })
  ctx.provide('resources', resources)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('documentPreviews', previews)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply: (scope: Context) => { apply(scope, retainDocumentTabs(scope)) } })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  return { tabs, previews, registered, fiber }
}

describe('direct content previews', () => {
  it('registers the shared tab and removes it with its service', async () => {
    const h = await boot()
    expect(h.tabs.get('content')).toMatchObject({ id: CONTENTPREVIEW_ID, patterns: ['dsh-resource://content-preview/**'] })
    expect(h.registered.map(entry => entry.component)).toEqual([ContentPreview, ContentTitle])
    expect(h.tabs.get('content')?.title?.('dsh-resource://content-preview/item')).toBe('t:content.title')
    await h.fiber.dispose()
    expect(h.tabs.get('content')).toBeUndefined()
    expect(h.registered).toEqual([])
  })

  it('forgets only the closed tab and ignores writes after its lifetime ends', async () => {
    const h = await boot()
    const body = h.registered[0]!
    const store = body.store!.create()
    const inject = body.inject as (sessionId: string, actions: BoundActions<ContentPreviewStore>) => ContentPreviewInjected
    const face = inject('session', store.actions)
    h.previews.register({ id: 'plain', extensions: [], mediaTypes: ['text/plain'], title: () => 'Plain', loading: 'text-pages' })
    expect(face.mediaTypeCandidates('text/plain').map(item => item.id)).toEqual(['plain'])
    const first = 'first' as TabId
    const second = 'second' as TabId
    const lifetime = new AbortController()
    const other = new AbortController()
    face.select(first, lifetime.signal, 'plain')
    face.scroll(second, other.signal, 20)
    expect(Object.keys(store.getSnapshot().byTab)).toHaveLength(2)
    lifetime.abort()
    expect(store.getSnapshot().byTab[first]).toBeUndefined()
    expect(store.getSnapshot().byTab[second]?.scrollTop).toBe(20)
    face.select(first, lifetime.signal, 'plain')
    face.toggleWrap(first, lifetime.signal)
    face.scroll(first, lifetime.signal, 50)
    expect(store.getSnapshot().byTab[first]).toBeUndefined()
    other.abort()
    expect(store.getSnapshot().byTab).toEqual({})
  })
})
