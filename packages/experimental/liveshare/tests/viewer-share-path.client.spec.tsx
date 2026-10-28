// @vitest-environment jsdom
/**
 * The reader page's own workspace-file claim: the tab type it registers for
 * `dsh-resource://file/**`, and the notice its body states.
 *
 * The bench boots the shipped right Sidebar (the type registry and the seat that resolves an address
 * through it) and the resources face it pins through, then mounts the viewer module, so the
 * assertions cover the routing a reader's click actually takes rather than a hand-built registry.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/src/client/index.ts'
import { apply as sidebarApply, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/viewer-share-path.tsx'

const SESSION = 'reader' as SessionId
const ADDRESS = `dsh-resource://file/session/${SESSION}/src/a.ts`
const UNAVAILABLE = '此页面无法打开工作区文件：分享提供的是文件路径，不是文件内容。'
const SHORTCUT_CATALOG: readonly never[] = []
let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

/**
 * One reader page: the shipped right Sidebar over the slot runtime, plus the viewer module.
 * @returns the runtime, the right Sidebar's rendered view, and the page's locale.
 */
async function boot() {
  const rt = await SlotTestRuntime.create()
  runtime = rt
  rt.ctx.provide('layout', { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: rt.panelInfo } as never)
  rt.ctx.provide('shortcuts', {
    register: () => () => {},
    catalog: { getSnapshot: () => SHORTCUT_CATALOG, subscribe: () => () => {} },
  } as never)
  const locale = new LocaleRuntime(rt.ctx)
  rt.ctx.provide('locale', locale)
  // The Liveshare client face registers the dictionaries this child plugin renders with.
  locale.register(NS, { zh, en })
  rt.slots.installLocale(locale)
  await act(async () => { locale.setLocale('zh') })
  await rt.declare({ rightbar: { kind: 'single', scope: 'root' } })
  await rt.sessions.add({ id: SESSION })
  await rt.sessions.retainFor(rt.ctx, SESSION, { source: 'mainView' }).ready
  await rt.mount({ inject: [...resourcesInject], apply: resourcesApply })
  await rt.mount({ inject: [...sidebarInject], apply: sidebarApply })
  await rt.mount({ inject: [...inject], apply })
  const view = rt.renderSlot('rightbar', { width: 600, viewportWidth: 1440, canShow: true })
  return { rt, view }
}

describe('viewer share-path claim', () => {
  it('claims a workspace-file address and titles the tab with the file name', async () => {
    const h = await boot()
    const [definition] = h.rt.ctx.sidebarRightTabs.candidates(ADDRESS)
    expect(definition).toMatchObject({
      kind: 'liveshare-share-path', patterns: ['dsh-resource://file/**'], priority: 'builtin',
    })
    expect(definition?.title(ADDRESS)).toBe('a.ts')
    expect(h.rt.ctx.sidebarRightTabs.claim(ADDRESS)).toEqual({
      kind: 'liveshare-share-path', contentId: ADDRESS, title: 'a.ts',
    })
  })

  it('titles an address that ends at a separator with the address itself', async () => {
    const h = await boot()
    const [definition] = h.rt.ctx.sidebarRightTabs.candidates(ADDRESS)

    // A directory-shaped address has no basename to show, so the address is the title.
    const directory = `dsh-resource://file/session/${SESSION}/src/`
    expect(definition?.title(directory)).toBe(directory)
  })

  it('titles a name that is not valid percent encoding as written, and decodes one that is', async () => {
    const h = await boot()
    const [definition] = h.rt.ctx.sidebarRightTabs.candidates(ADDRESS)

    // Decoding a malformed sequence fails; the reader still sees the name the address states.
    expect(definition?.title('dsh-resource://file/session/x/100%.ts')).toBe('100%.ts')
    expect(definition?.title('dsh-resource://file/session/x/a%20b.ts')).toBe('a b.ts')
  })

  it('states in the tab why this page cannot show the file', async () => {
    const h = await boot()
    act(() => { h.rt.ctx.sidebarRight.openResource(ADDRESS) })
    await waitFor(() => {
      expect(h.view.container.querySelector(`[data-liveshare-share-path="${ADDRESS}"]`)?.textContent)
        .toBe(UNAVAILABLE)
    })
  })
})
