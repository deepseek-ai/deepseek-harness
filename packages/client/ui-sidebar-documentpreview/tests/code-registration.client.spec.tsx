// @vitest-environment jsdom
/** Code renderer registration lifetimes through the production document and Slot registries. */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply } from '../src/client/code/index.ts'
import { CodeBody } from '../src/client/code/CodeBody.tsx'
import { CODE_EXTENSIONS } from '../src/client/code/languages.ts'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { documentTabInfoFactory } from '../src/client/document/contract.ts'

const ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code'
const SLOT = 'sidebar.right.tab.document'
const plugin = { inject: ['slots', 'locale', 'documentPreviews'], apply }
let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

async function boot() {
  const rt = await SlotTestRuntime.create()
  runtime = rt
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  rt.slots.installLocale(locale)
  const previews = new DocumentPreviewRegistry()
  rt.ctx.provide('documentPreviews', previews)
  const declare = () => rt.declare({
    [SLOT]: { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: documentTabInfoFactory } } },
  })
  return { rt, locale, previews, declare }
}

describe('code renderer registration', () => {
  it('publishes builtin metadata before the document slot exists and waits to register its body', async () => {
    const h = await boot()
    await h.rt.mount(plugin)
    expect(h.previews.getSnapshot()).toHaveLength(1)
    expect(h.previews.getSnapshot()[0]).toMatchObject({ id: ID, extensions: CODE_EXTENSIONS, priority: 'builtin', loading: 'text-pages', wrap: true })
    expect(h.rt.slots.entries(SLOT)).toEqual([])
    await h.declare()
    const entries = h.rt.slots.entries(SLOT)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ options: { key: ID }, locale: 'sidebarCodePreview', component: CodeBody })
    expect(h.previews.candidates('notes.unknown')).toEqual([])
  })

  it('resolves localized names at read time and removes metadata, locale, and body on disposal', async () => {
    const h = await boot()
    await h.declare()
    const feature = await h.rt.mount(plugin)
    const definition = h.previews.getSnapshot()[0]
    await act(async () => { h.locale.setLocale('en') })
    expect(definition?.title()).toBe('Code')
    await act(async () => { h.locale.setLocale('zh') })
    expect(definition?.title()).toBe('代码')
    await feature.dispose()
    expect(h.previews.getSnapshot()).toEqual([])
    expect(h.rt.slots.entries(SLOT)).toEqual([])
    expect(h.locale.bind('sidebarCodePreview')('title')).toBe('title')
  })

  it('remounts the keyed body after the document owner redeclares its slot', async () => {
    const h = await boot()
    await h.declare()
    await h.rt.mount(plugin)
    await act(async () => { h.rt.root.release() })
    expect(h.rt.slots.entries(SLOT)).toEqual([])
    expect(h.previews.getSnapshot()).toHaveLength(1)
    await h.declare()
    expect(h.rt.slots.entries(SLOT)).toHaveLength(1)
  })

  it('keeps prior HTML and Markdown builtins ahead of their optional source renderer', async () => {
    const h = await boot()
    for (const extension of ['html', 'md']) {
      h.rt.ctx.effect(() => h.previews.register({
        id: `dedicated-${extension}`, extensions: [extension], priority: 'builtin',
        title: () => extension, loading: extension === 'html' ? 'bytes-complete' : 'text-pages',
      }))
    }
    await h.rt.mount(plugin)
    expect(h.previews.candidates('page.html').map(item => item.id)).toEqual(['dedicated-html', ID])
    expect(h.previews.candidates('README.md').map(item => item.id)).toEqual(['dedicated-md', ID])
  })
})
