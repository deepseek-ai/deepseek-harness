// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { CordisActionRow } from '../src/client/CordisActionRow.tsx'
import { CordisDefineRow } from '../src/client/CordisDefineRow.tsx'
import { CordisRunRow } from '../src/client/CordisRunRow.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof zh) => zh[key]) as Parameters<typeof CordisActionRow>[0]['t']

function failed(name: string): ToolResultNode {
  return {
    kind: 'tool-result', seq: 2, time: 2, callId: `call-${name}`,
    call: { name, argsRaw: '{}' }, callTime: 1,
    content: [{ type: 'text', text: 'failed' }], isError: true, subCalls: [],
  }
}

const useValue = <T,>(value: T) => <Selected,>(selector: (snapshot: T) => Selected): Selected => selector(value)
const callbacks = {
  openFile: vi.fn(), loadImage: vi.fn(),
  useDisclosure: () => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() }),
}

describe('Cordis tool failure icons', () => {
  it.each([
    ['cordis_define', CordisDefineRow], ['cordis_run', CordisRunRow],
    ['cordis_stop', CordisActionRow], ['cordis_undefine', CordisActionRow],
  ] as const)('%s prepares without invoking its inventory or execution hooks', (toolName, Component) => {
    const unused = vi.fn(() => { throw new Error('preparation must not read execution details') })
    const props = {
      ...callbacks,
      phase: 'preparing', toolName, callId: 'call', t,
      block: { phase: 'preparing', name: toolName, callId: 'call', turn: 1, step: 1, time: 1, subCalls: [] },
      useInventory: unused, useLoaded: unused, useRunCards: unused, useActiveRuns: unused, useDisclosure: unused,
    } as Parameters<typeof CordisDefineRow>[0] & Parameters<typeof CordisRunRow>[0]
    const view = render(<Component {...props} />)
    expect(view.container.querySelector('[data-state="preparing"] svg')).not.toBeNull()
    expect(view.queryByRole('button')).toBeNull()
    expect(unused).not.toHaveBeenCalled()
  })

  it('retains the code glyph for define and run failures', () => {
    const common = {
      ...callbacks,
      inspect: undefined,
      t,
      useInventory: useValue({ rows: [], removed: new Set<CordisDynamicPluginId>(), read: true }),
      useLoaded: useValue([]),
    }
    const define = render(<CordisDefineRow {...{
      ...common, callId: 'call-cordis_define', toolName: 'cordis_define', phase: 'result' as const, block: failed('cordis_define'),
    } as Parameters<typeof CordisDefineRow>[0]} />)
    expect(define.container.querySelector('[data-tool="cordis_define"] [data-disclosure-row] > :first-child svg')).not.toBeNull()
    expect(define.container.querySelector('[data-tool="cordis_define"] [data-state]')).toBeNull()
    define.unmount()

    const run = render(<CordisRunRow {...{
      ...common, callId: 'call-cordis_run', toolName: 'cordis_run', phase: 'result' as const, block: failed('cordis_run'),
      renderSlot: vi.fn(), useRunCards: useValue(new Map()), useActiveRuns: useValue(new Map()),
      onObserveRunCard: vi.fn(),
    } as Parameters<typeof CordisRunRow>[0]} />)
    expect(run.container.querySelector('[data-tool="cordis_run"] > div:first-child > span:first-child svg')).not.toBeNull()
    expect(run.container.querySelector('[data-tool="cordis_run"] [data-state]')).toBeNull()
  })

  it('retains the code glyph for interrupted define and run calls', () => {
    const interrupted = (name: string): ToolResultNode => ({
      ...failed(name),
      error: { name: 'InterruptedError', code: 'interrupted' },
    })
    const common = {
      ...callbacks, inspect: undefined, t,
      useInventory: useValue({ rows: [], removed: new Set<CordisDynamicPluginId>(), read: true }),
      useLoaded: useValue([]),
    }
    const define = render(<CordisDefineRow {...{
      ...common, callId: 'call-cordis_define', toolName: 'cordis_define', phase: 'result', block: interrupted('cordis_define'),
    } as Parameters<typeof CordisDefineRow>[0]} />)
    expect(define.container.querySelector('[data-tool="cordis_define"] [data-disclosure-row] > :first-child svg')).not.toBeNull()
    expect(define.container.querySelector('[data-tool="cordis_define"] [data-state]')).toBeNull()
    define.unmount()

    const run = render(<CordisRunRow {...{
      ...common, callId: 'call-cordis_run', toolName: 'cordis_run', phase: 'result', block: interrupted('cordis_run'),
      renderSlot: vi.fn(), useRunCards: useValue(new Map()), useActiveRuns: useValue(new Map()),
      onObserveRunCard: vi.fn(),
    } as Parameters<typeof CordisRunRow>[0]} />)
    expect(run.container.querySelector('[data-tool="cordis_run"] > div:first-child > span:first-child svg')).not.toBeNull()
    expect(run.container.querySelector('[data-tool="cordis_run"] [data-state]')).toBeNull()
  })

  it('uses the dashed code glyph when a successful run receipt later reports activation failure', () => {
    const pluginId = 'plugin-1' as CordisDynamicPluginId
    const packageId = 'package-1' as CordisDynamicPackageId
    const pluginRunId = 'run-1' as CordisDynamicPluginRunId
    const block: ToolResultNode = {
      kind: 'tool-result', seq: 3, time: 3, callId: 'call-cordis_run', callTime: 2,
      call: { name: 'cordis_run', argsRaw: JSON.stringify({ pluginId, packageId, mode: 'run' }) },
      content: [], isError: false, subCalls: [], meta: { pluginId, packageId, pluginRunId },
    }
    const view = render(<CordisRunRow {...{
      ...callbacks,
      callId: block.callId, toolName: 'cordis_run', phase: 'result', block, openFile: vi.fn(), inspect: undefined, t,
      useInventory: useValue({
        rows: [{
          pluginId, agentId: 'session-1' as SessionId, packages: [{
            packageId, name: 'Plugin', purpose: 'test', hasHostHalf: true, hasClientHalf: false,
          }],
          latestRun: {
            pluginRunId, packageId, mode: 'run', status: 'failed',
            host: { status: 'failed', waitingFor: [] }, client: { status: 'absent', waitingFor: [] },
            error: { phase: 'host-apply', message: 'boom', pluginId, packageId, pluginRunId },
          },
        }],
        removed: new Set<CordisDynamicPluginId>(), read: true,
      }),
      useLoaded: useValue([]), renderSlot: vi.fn(), useRunCards: useValue(new Map()),
      useActiveRuns: useValue(new Map()), onObserveRunCard: vi.fn(),
    } as Parameters<typeof CordisRunRow>[0]} />)
    expect(view.container.querySelector('[data-cordis-status="failed"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="ok"] svg')).not.toBeNull()
  })

  it.each(['cordis_stop', 'cordis_undefine'] as const)('%s retains its action icon on failure', (toolName) => {
    const view = render(<CordisActionRow {...{
      ...callbacks,
      callId: `call-${toolName}`, toolName, phase: 'result' as const, block: failed(toolName), inspect: undefined, t,
    } as Parameters<typeof CordisActionRow>[0]} />)
    expect(view.container.querySelector('[data-state="error"] svg')).not.toBeNull()
    expect(view.container.querySelector('[data-state="error"] [data-state]')).toBeNull()
  })

  it.each(['cordis_stop', 'cordis_undefine'] as const)('%s retains its action icon when interrupted', (toolName) => {
    const block: ToolResultNode = {
      ...failed(toolName),
      error: { name: 'InterruptedError', code: 'interrupted' },
    }
    const view = render(<CordisActionRow {...{
      ...callbacks,
      callId: `call-${toolName}`, toolName, phase: 'result', block, inspect: undefined, t,
    } as Parameters<typeof CordisActionRow>[0]} />)
    expect(view.container.querySelector('[data-state="stopped"] svg')).not.toBeNull()
    expect(view.container.querySelector('[data-state="stopped"] [data-state]')).toBeNull()
  })
})
