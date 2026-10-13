// @vitest-environment jsdom
import { useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'spec.inline.single': { kind: 'single'; scope: 'root'; inline: true }
    'spec.inline.keyed': { kind: 'keyed'; scope: 'root'; inline: true }
    'spec.inline.list': { kind: 'list'; scope: 'root'; inline: true }
    'spec.inline.chain': { kind: 'chain'; scope: 'root'; inline: true; owner: { enabled: boolean } }
    'spec.inline.child': { kind: 'single'; scope: 'root'; inline: true }
    'spec.inline.block': { kind: 'single'; scope: 'root' }
  }
  interface SlotFactoryMap {
    'spec.inline.factory': {
      scope: 'root'
      children: { 'spec.inline.child': { kind: 'single'; scope: 'root'; inline: true } }
    }
  }
}

afterEach(cleanup)

async function setup() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  return runtime
}

function Crashed(): never {
  throw new Error('inline entry failed')
}

describe('inline Slot anchors', () => {
  it('keeps inline anchors and exhausted cells as spans while ordinary Slots remain divs', async () => {
    const runtime = await setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    await runtime.root.declare({
      'spec.inline.single': { kind: 'single', scope: 'root', inline: true },
      'spec.inline.keyed': { kind: 'keyed', scope: 'root', inline: true },
      'spec.inline.list': { kind: 'list', scope: 'root', inline: true },
      'spec.inline.block': { kind: 'single', scope: 'root' },
    }, ({ renderSlot }) => <>
      {renderSlot('spec.inline.single', {})}
      {renderSlot('spec.inline.keyed', {}, { entryKey: 'failed' })}
      {renderSlot('spec.inline.list', {})}
      {renderSlot('spec.inline.block', {}, { fallback: <span>Ordinary fallback</span> })}
    </>)
    runtime.slots.register({ name: 'spec.inline.single' }, Crashed)
    runtime.slots.register({ name: 'spec.inline.keyed', key: 'failed' }, Crashed)
    runtime.slots.register({ name: 'spec.inline.list', id: 'failed' }, Crashed)
    const view = runtime.renderRoot()
    await act(async () => {})
    for (const name of ['spec.inline.single', 'spec.inline.keyed', 'spec.inline.list'] as const) {
      const anchor = view.container.querySelector(`[data-slot="${name}"]`)
      expect(anchor?.tagName).toBe('SPAN')
      expect(anchor?.querySelector('[data-slot-error]')?.tagName).toBe('SPAN')
      expect(runtime.slots.entries(name)).toHaveLength(1)
    }
    expect(view.container.querySelector('[data-slot="spec.inline.block"]')?.tagName).toBe('DIV')
    expect(view.getByText('Ordinary fallback')).toBeTruthy()
  })

  it('uses span overlay fallbacks and span error boundaries for inline chains', async () => {
    const runtime = await setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    await runtime.root.declare({
      'spec.inline.chain': { kind: 'chain', scope: 'root', inline: true },
    }, ({ renderSlotChain }) => {
      const [enabled, setEnabled] = useState(false)
      return <>
        <button onClick={() => { setEnabled(true) }}>Enable</button>
        {renderSlotChain('spec.inline.chain', { enabled }, {
          fallback: <span>Fallback</span>, overlay: true, fallbackOnly: !enabled,
        })}
      </>
    })
    runtime.slots.register({ name: 'spec.inline.chain', select: ({ enabled }) => enabled ? {} : null }, Crashed)
    const view = runtime.renderRoot()
    const fallback = view.container.querySelector<HTMLElement>('[data-chain-overlay-fallback]')!
    expect(fallback.tagName).toBe('SPAN')
    expect(fallback.style.display).toBe('contents')
    fireEvent.click(view.getByRole('button', { name: 'Enable' }))
    expect(view.container.querySelector('[data-chain-overlay-fallback]')).toBe(fallback)
    expect(fallback.style.display).toBe('none')
    expect(view.container.querySelector('[data-slot-error="spec.inline.chain"]')?.tagName).toBe('SPAN')
  })

  it('retains the inline child anchor after its Factory declaration is disposed', async () => {
    const runtime = await setup()
    let retained: ReactNode = null
    const dispose = runtime.slots.registerFactory({
      name: 'spec.inline.factory', scope: 'root',
      children: { 'spec.inline.child': { kind: 'single', scope: 'root', inline: true } },
    }, ({ renderSlot }) => {
      retained = renderSlot('spec.inline.child', {}, { fallback: <span>Child fallback</span> })
      return retained
    })
    runtime.slots.register({ name: 'spec.inline.child' }, () => <span>Child</span>)
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => {
      const [hold, setHold] = useState(false)
      return <>
        <button onClick={() => { setHold(true) }}>Retain child</button>
        {hold ? retained : renderFactorySlot('spec.inline.factory', {})}
      </>
    })
    const view = runtime.renderRoot()
    expect(view.getByText('Child')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Retain child' }))
    const anchor = view.container.querySelector('[data-slot="spec.inline.child"]')!
    expect(anchor.tagName).toBe('SPAN')
    await act(async () => { dispose() })
    expect(view.container.querySelector('[data-slot="spec.inline.child"]')).toBe(anchor)
    expect(anchor.textContent).toBe('')
    expect(view.queryByText('Child fallback')).toBeNull()
    expect(runtime.slots.entries('spec.inline.child')).toHaveLength(0)
  })
})
