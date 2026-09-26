/** Image metadata, keyed slot, dictionary, and disposal registration. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { ImageBody } from '../src/client/image/ImageBody.tsx'
import { apply, BINARY_IMAGE_EXTENSIONS, IMAGE_BODY_ID, IMAGE_EXTENSIONS, imageBodyDefinition } from '../src/client/image/index.ts'
import { en, zh } from '../src/client/image/locales.ts'
import type { ZoomInjected, ZoomStore } from '../src/client/zoom/store.ts'

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined })

describe('image registration', () => {
  it('claims common image suffixes as a builtin complete-byte renderer without wrap', () => {
    const title = vi.fn(() => 'localized image')
    const definition = imageBodyDefinition(title)
    expect(definition).toMatchObject({
      id: IMAGE_BODY_ID,
      extensions: IMAGE_EXTENSIONS,
      binaryExtensions: BINARY_IMAGE_EXTENSIONS,
      priority: 'builtin',
      title,
      loading: 'bytes-complete',
      wrap: false,
    })
    expect(title).not.toHaveBeenCalled()
    expect(definition.title()).toBe('localized image')
  })

  it('registers its dictionary and matching keyed body, then removes every contribution', async () => {
    const ctx = new Context()
    const registry = new DocumentPreviewRegistry()
    const dictionaries = new Map<string, unknown>()
    const bodies = new Map<string, unknown>()
    type Options = {
      name: string
      key: string
      locale: string
      store: ZoomStore
      inject: (sessionId: SessionId, actions: ReturnType<ZoomStore['create']>['actions']) => ZoomInjected
    }
    const entries: Options[] = []
    const register = vi.fn((options: Options, body: unknown) => {
      bodies.set(options.key, body)
      entries.push(options)
      return () => { bodies.delete(options.key); entries.splice(entries.indexOf(options), 1) }
    })
    ctx.provide('documentPreviews', registry)
    ctx.provide('slots', { inject: (_key: string, callback: () => () => void) => callback(), register } as never)
    ctx.provide('locale', {
      bind: () => (key: keyof typeof en) => en[key],
      register: (name: string, value: unknown) => {
        dictionaries.set(name, value)
        return () => { dictionaries.delete(name) }
      },
    } as never)
    const fiber = ctx.plugin({ apply })
    dispose = async () => { await fiber.dispose() }
    await fiber.await()
    for (const extension of IMAGE_EXTENSIONS) {
      expect(registry.candidates(`ASSET.${extension}`).map(entry => entry.id)).toEqual([IMAGE_BODY_ID])
    }
    expect(registry.getSnapshot()[0]?.title()).toBe(en.title)
    expect(dictionaries.get('sidebarImage')).toEqual({ zh, en })
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: 'sidebar.right.tab.document', key: IMAGE_BODY_ID, locale: 'sidebarImage',
    }), ImageBody)
    expect(entries[0]?.store).toBeDefined()
    expect(typeof entries[0]?.inject).toBe('function')
    const instance = entries[0]!.store.create()
    const face = entries[0]!.inject('image-session' as SessionId, instance.actions)
    const controller = new AbortController()
    face.retainTab('image-tab' as TabId, controller.signal)
    instance.actions.zoom('image-tab' as TabId, { kind: 'fixed', scale: 1.5 })
    controller.abort()
    expect(instance.getSnapshot().byTab).toEqual({})
    await dispose()
    expect(registry.getSnapshot()).toEqual([])
    expect(bodies.size).toBe(0)
    expect(entries).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
