// @vitest-environment jsdom
/** Markdown metadata, deferred slot registration, localization, and unload through the real renderer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { documentTabInfoFactory } from '../src/client/document/contract.ts'
import { apply, MARKDOWN_BODY_ID, markdownDefinition } from '../src/client/markdown/index.ts'

const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

describe('Markdown implementation registration', () => {
  it('declares builtin paged Markdown for both suffixes without consuming source wrap', () => {
    let title = 'Markdown'
    const definition = markdownDefinition(() => title)
    expect(definition).toMatchObject({
      id: MARKDOWN_BODY_ID, extensions: ['md', 'markdown'], priority: 'builtin', loading: 'text-pages', wrap: false,
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

  it('waits for the document slot, renders with its locale, and releases every contribution on unload', async () => {
    const runtime = await SlotTestRuntime.create()
    runtimes.push(runtime)
    const previews = new DocumentPreviewRegistry()
    runtime.ctx.provide('documentPreviews', previews)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    locale.setLocale('en')
    await runtime.sessions.add({ id: 'markdown-registration' })
    const feature = await runtime.mount({ inject: ['slots', 'locale', 'documentPreviews'], apply })
    expect(previews.getSnapshot().map(definition => definition.id)).toEqual([MARKDOWN_BODY_ID])
    const useTabInfo = vi.fn<UseSidebarRightTabInfo>(() => { throw new Error('Markdown rendering does not need tab actions') })
    await runtime.root.declare({
      'sidebar.right.tab.document': {
        kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: documentTabInfoFactory } },
      },
    }, ({ renderSlot }) => renderSlot('sidebar.right.tab.document', {
      resourceAddress: 'dsh-resource://file/session/markdown-registration/notes.md',
      content: { kind: 'text', text: '# Notes\n\n```ts\nconst value = 1\n```', pages: [], eof: true },
      wrap: false,
      scrollportRef: vi.fn(),
    }, { entryKey: MARKDOWN_BODY_ID, hookContext: useTabInfo, fallback: <span data-missing-markdown /> }))
    const view = runtime.renderRoot()
    expect(view.getByRole('heading', { name: 'Notes' })).toBeDefined()
    expect(view.getByRole('button', { name: 'Copy' })).toBeDefined()
    expect(runtime.slots.entries('sidebar.right.tab.document')).toHaveLength(1)
    const t = locale.bind('documentMarkdown')
    await act(async () => { locale.setLocale('zh') })
    expect(locale.bind('documentMarkdown')).toBe(t)
    expect(view.getByRole('button', { name: '复制' })).toBeDefined()
    expect(useTabInfo).not.toHaveBeenCalled()

    await feature.dispose()
    expect(previews.getSnapshot()).toEqual([])
    expect(runtime.slots.entries('sidebar.right.tab.document')).toEqual([])
    expect(view.container.querySelector('[data-missing-markdown]')).not.toBeNull()
    expect(t('code.copy')).toBe('code.copy')
    await runtime.mount({ inject: ['slots', 'locale', 'documentPreviews'], apply })
    expect(previews.getSnapshot()).toHaveLength(1)
    expect(view.getByRole('button', { name: '复制' })).toBeDefined()
  })
})
