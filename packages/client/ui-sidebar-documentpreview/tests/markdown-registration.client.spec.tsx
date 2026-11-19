// @vitest-environment jsdom
/** Markdown metadata, deferred slot registration, localization, and unload through the real renderer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { apply, MARKDOWN_BODY_ID, markdownDefinition } from '../src/client/markdown/index.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { registerDocumentViewer } from '../src/client/content/index.ts'
import { en as previewEn, zh as previewZh } from '../src/client/locales.ts'

const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

describe('Markdown implementation registration', () => {
  it('declares builtin paged Markdown for both suffixes without consuming source wrap', () => {
    let title = 'Markdown'
    const definition = markdownDefinition(() => title)
    expect(definition).toMatchObject({
      id: MARKDOWN_BODY_ID, extensions: ['md', 'markdown'], mediaTypes: ['text/markdown'], priority: 'builtin', loading: 'text-pages', wrap: false,
    })
    expect(definition.title()).toBe('Markdown')
    title = 'Localized Markdown'
    expect(definition.title()).toBe(title)
    const registry = new DocumentPreviewRegistry()
    const unregister = registry.register(definition)
    for (const path of ['notes.md', 'NOTES.MD', 'notes.markdown']) expect(registry.candidates(path)).toEqual([definition])
    expect(registry.candidates('notes.txt')).toEqual([])
    unregister()
    expect(registry.getSnapshot()).toEqual([])
  })

  it('waits for the document body Factory, follows its declaration lifetime, and releases every contribution on unload', async () => {
    const runtime = await SlotTestRuntime.create()
    runtimes.push(runtime)
    const previews = new DocumentPreviewRegistry()
    runtime.ctx.provide('documentPreviews', previews)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    runtime.ctx.effect(() => locale.register('sidebarDocumentPreview', { zh: previewZh, en: previewEn }))
    locale.setLocale('en')
    const sessionId = brandString<SessionId>('markdown-registration')
    await runtime.sessions.add({ id: sessionId })
    const reference = runtime.sessions.retainFor(runtime.ctx, sessionId)
    await reference.ready
    await runtime.mount({ inject: [...resourcesInject], apply: resourcesApply })
    runtime.ctx.effect(() => runtime.ctx.resources.register({
      protocol: 'file',
      open: async function* () {
        yield { ok: true as const, value: { absolutePath: '/work/guide/notes.md', version: 'v1' } }
      },
    }))
    // The renderer waits through `ctx.slots.inject` until the Factory declares its slot.
    const feature = await runtime.mount({ inject: ['slots', 'locale', 'documentPreviews'], apply })
    expect(previews.getSnapshot().map(definition => definition.id)).toEqual([MARKDOWN_BODY_ID])
    const registerFactory = (): (() => void) => registerDocumentViewer(runtime.ctx, () => {})
    let unregister = registerFactory()
    await runtime.flush()
    expect(runtime.slots.entries('sidebar.right.tab.document')).toHaveLength(1)
    const useTabInfo = vi.fn<UseSidebarRightTabInfo>(() => { throw new Error('Markdown rendering does not need tab actions') })
    const address = 'dsh-resource://file/session/markdown-registration/notes.md'
    await runtime.root.declare({
      'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
    }, ({ renderFactorySlot, SessionProvider }) => (
      <SessionProvider session={reference}>
        {renderFactorySlot('sidebar.right.document.body', {
          rendererId: MARKDOWN_BODY_ID, useTabInfo, resourceAddress: address, baseAddress: address,
          content: { kind: 'text', text: '# Notes\n\n```ts\nconst value = 1\n```\n\n![diagram](images/a.png)', pages: [], eof: true },
          wrap: false,
          scrollportRef: vi.fn(),
          addResource: vi.fn(), setResources: vi.fn(),
        })}
      </SessionProvider>
    ))
    const view = runtime.renderRoot()
    expect(view.getByRole('heading', { name: 'Notes' })).toBeDefined()
    expect(view.getByRole('button', { name: 'Copy' })).toBeDefined()
    await waitFor(() => {
      expect(new URL(view.getByAltText('diagram').getAttribute('src')!).searchParams.get('path'))
        .toBe('/work/guide/images/a.png')
    })
    const t = locale.bind('documentMarkdown')
    await act(async () => { locale.setLocale('zh') })
    expect(locale.bind('documentMarkdown')).toBe(t)
    expect(view.getByRole('button', { name: '复制' })).toBeDefined()
    expect(useTabInfo).not.toHaveBeenCalled()

    // The contribution collapses with the Factory's declaration and returns with the next one.
    await act(async () => { unregister() })
    expect(view.queryByRole('heading', { name: 'Notes' })).toBeNull()
    unregister = registerFactory()
    await runtime.flush()
    expect(runtime.slots.entries('sidebar.right.tab.document')).toHaveLength(1)
    expect(view.getByRole('heading', { name: 'Notes' })).toBeDefined()

    await feature.dispose()
    expect(previews.getSnapshot()).toEqual([])
    expect(runtime.slots.entries('sidebar.right.tab.document')).toEqual([])
    expect(view.getByText(previewZh.rendererUnavailable.replace('{name}', MARKDOWN_BODY_ID))).toBeDefined()
    expect(t('code.copy')).toBe('code.copy')
    await runtime.mount({ inject: ['slots', 'locale', 'documentPreviews'], apply })
    expect(previews.getSnapshot()).toHaveLength(1)
    expect(view.getByRole('button', { name: '复制' })).toBeDefined()
  })
})
