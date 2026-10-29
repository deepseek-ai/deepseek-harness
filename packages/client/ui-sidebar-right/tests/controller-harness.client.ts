/** A real registry, controller and adopted Session store; each spec decides when to show it. */
import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LayoutState, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createSidebarRightController } from '../src/client/service.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { guideDefinition } from '../src/client/tabs/guide/definition.ts'

// A test-only scheme supplies typed parameters without depending on a resource plugin.
declare module '../src/client/contract/params.ts' {
  interface SidebarRightResourceParamsMap {
    test: { line?: number; x?: number }
  }
}

export const SESSION = 's-test' as SessionId
const t = ((key: string) => key) as Parameters<typeof guideDefinition>[0]

/** Construct a controller without publishing its Session or creating its surface. */
export function controllerHarness() {
  const tabs = new SidebarRightTabRegistry(new Context())
  tabs.register(guideDefinition(t))
  tabs.register({
    id: 'test/text', kind: 'text', patterns: ['dsh-resource://file/**'], priority: 'fallback',
    title: address => address.slice(address.lastIndexOf('/') + 1),
  })
  const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
  const { controller, adopt, forget, show, measure } = createSidebarRightController(tabs, pin, {
    autoFullscreen: () => false,
    openWithFocus: (_sessionId, open) => { open() },
    closeWithFocus: (_sessionId, _paneId, close) => { close() },
  })
  const instance = createSidebarRightStore(() => ({ kind: 'guide', title: 'seed' })).create()
  const unadopt = adopt(SESSION, instance)
  const layout = (): LayoutState => {
    const surface = instance.getSnapshot().bySession[SESSION]
    if (surface === undefined) throw new Error('expected a surface')
    return surface.layout
  }
  const room = { allowed: true }
  /** Publish with the room rule a rendered seat reports. */
  const publish = (): (() => void) => {
    show(SESSION)
    measure(SESSION, () => room.allowed)
    return () => { show(undefined) }
  }
  const titles = (): string[] => {
    const surface = instance.getSnapshot().bySession[SESSION]
    return surface === undefined ? [] : Object.values(surface.layout.tabs).map(tab => tab.title)
  }
  const tabOf = (title: string): TabId => {
    const found = Object.values(layout().tabs).find(tab => tab.title === title)
    if (found === undefined) throw new Error(`expected a tab titled ${title}`)
    return found.id
  }
  const entries = (): number => instance.getSnapshot().bySession[SESSION]?.history.entries.length ?? 0
  const expand = (): void => { instance.actions.setExpanded(SESSION, true) }
  return { controller, adopt, unadopt, forget, show, measure, tabs, instance, pin, publish, titles, tabOf, layout, entries, room, expand }
}
