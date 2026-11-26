// @vitest-environment jsdom
/** The open Cordis panel stays anchored above its footer trigger within the application viewport. */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CordisDynamicPackageId, CordisDynamicPluginId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { CordisPanel, type CordisPanelProps } from '../src/client/CordisPanel.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const useValue = <T,>(value: T) => <Selected,>(selector: (snapshot: T) => Selected): Selected => selector(value)
const t = ((key: keyof typeof en) => en[key]) as CordisPanelProps['t']
const onRefresh = vi.fn()

function panelProps(viewport: { width: number; height: number }): CordisPanelProps {
  return {
    wide: true, t, onRefresh,
    useSessions: useValue({ byId: {} }),
    useDocumentViewport: () => viewport,
    useInventory: useValue({
      rows: [{ pluginId: 'plugin-1' as CordisDynamicPluginId, agentId: 'session-1' as SessionId, packages: [{
        packageId: 'package-1' as CordisDynamicPackageId, name: 'Plugin', purpose: 'test', hasHostHalf: true, hasClientHalf: false,
      }] }],
      removed: new Set<CordisDynamicPluginId>(), read: true,
    }),
    useActiveRuns: useValue(new Map()), useRunErrors: useValue(new Map()), useLoaded: useValue([]),
    useRenderFailures: useValue(new Map()),
    onApprove: vi.fn(), onDecline: vi.fn(), onRun: vi.fn(), onStop: vi.fn(), onRemove: vi.fn(),
  } as CordisPanelProps
}

it('places the open panel from the trigger and the application viewport height, again when that viewport changes', () => {
  const ui = render(<CordisPanel {...panelProps({ width: 1024, height: 768 })} />)
  const root = ui.container.firstElementChild as HTMLElement
  root.getBoundingClientRect = () => new DOMRect(12, 700, 200, 40)
  expect(ui.container.querySelector('[data-cordis-panel]')).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: en['panel.plugins.aria'] }))
  const panel = () => ui.container.querySelector<HTMLElement>('[data-cordis-panel]')!
  expect([panel().style.left, panel().style.bottom]).toEqual(['12px', '76px'])
  ui.rerender(<CordisPanel {...panelProps({ width: 1024, height: 900 })} />)
  expect([panel().style.left, panel().style.bottom]).toEqual(['12px', '208px'])
})
