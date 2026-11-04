// @vitest-environment jsdom
/**
 * Hoc slots over the real ui-slots SlotCore: nesting order, owner and
 * children delivery, remount semantics, crash skipping, and every scope.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Component, useEffect, useState, type ReactNode } from 'react'
import {
  SlotCore, type PropsRenderSlots, type ScopedStandardSourceBinding, type SlotRendererHost,
  type SlotScopeAdapter, type StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '../src/client/scoped-slots.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'spec.hoc': { kind: 'hoc'; scope: 'root'; owner: { tone: string } }
    'spec.hoc.maybe': { kind: 'hoc'; scope: 'session-maybe' }
    'spec.hoc.session': { kind: 'hoc'; scope: 'session' }
  }
}

type Frame = PropsRenderSlots<'spec.hoc' | 'spec.hoc.maybe' | 'spec.hoc.session'>

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Passthrough host over the real core whose current scope is one live Session. */
function hostOver(core: SlotCore): SlotRendererHost {
  const rootBinding: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
  const session = { key: 'S1', ctx: new Context(), hooks: {}, keyedHooks: {}, props: {} } as ScopedStandardSourceBinding
  const source = <T,>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
  const sessionSource = source<StandardSourceBinding>(session)
  const adapter: SlotScopeAdapter = {
    current: sessionSource,
    bindingSource: () => sessionSource,
    renderArea: (_binding, { children }) => <>{children}</>,
  }
  return {
    subscribe: (key, fn) => core.subscribe(key, fn),
    getVersion: key => core.getVersion(key),
    entriesOf: key => core.entries(key),
    entriesOfSlot: key => core.entriesOfSlot(key),
    reportEntryError: (key, entry, error, info) => { core.reportEntryError(key, entry, error, info) },
    reportFactoryError: () => {},
    specOf: key => core.specDynamic(key),
    isLive: entry => core.isLive(entry),
    storeOf: () => undefined,
    factoryStoreOf: () => undefined,
    retainFactoryOccurrence: () => () => {},
    subscribeFactory: () => () => {},
    getFactoryVersion: () => 0,
    factoryOf: () => undefined,
    isFactoryLive: () => false,
    root: source(rootBinding),
    scopeRevision: source(0),
    scope: () => adapter,
  }
}

const flush = () => act(async () => { await Promise.resolve() })

const mounts = vi.fn()

function Content({ label = 'content' }: { label?: string }) {
  useEffect(() => { mounts(label) }, [label])
  return <p data-testid={label}>{label}</p>
}

/** A layer that wraps its children in a section carrying its id and the owner's tone. */
function layer(id: string) {
  return ({ tone, children }: { tone?: string; children: ReactNode }) => (
    <section data-layer={id} data-tone={tone}>{children}</section>
  )
}

let setTone: (tone: string) => void = () => {}

/** Register the root declaring the hoc slots, render the root-scope hoc around Content, and mount. */
function mount(core: SlotCore, body?: (renderSlot: Frame['renderSlot']) => ReactNode) {
  core.register({
    name: 'root',
    children: {
      'spec.hoc': { kind: 'hoc', scope: 'root' },
      'spec.hoc.maybe': { kind: 'hoc', scope: 'session-maybe' },
      'spec.hoc.session': { kind: 'hoc', scope: 'session' },
    },
  }, function Root(props: Frame) {
    const [tone, set] = useState('calm')
    setTone = set
    return <>{body?.(props.renderSlot) ?? props.renderSlot('spec.hoc', { tone }, { children: <Content /> })}</>
  } as never)
  return render(<>{createSlotRenderer().renderRoot(hostOver(core), {})}</>)
}

describe('hoc slots', () => {
  it('renders the content unchanged without layers, then nests layers lowest order outermost', async () => {
    const core = new SlotCore()
    const view = mount(core)
    expect(view.getByTestId('content')).toBeTruthy()
    expect(view.container.querySelector('section')).toBeNull()

    core.register({ name: 'spec.hoc', id: 'inner', order: 10 }, layer('inner') as never)
    core.register({ name: 'spec.hoc', id: 'outer' }, layer('outer') as never)
    await flush()
    const outer = view.container.querySelector('section[data-layer="outer"]')
    const inner = outer?.querySelector(':scope > section[data-layer="inner"]')
    expect(inner?.querySelector(':scope > p')?.textContent).toBe('content')
    expect(outer?.getAttribute('data-tone')).toBe('calm')
    expect(inner?.getAttribute('data-tone')).toBe('calm')
  })

  it('updates owner props without remounting the content, and remounts it when the layer set changes', async () => {
    const core = new SlotCore()
    mounts.mockClear()
    const view = mount(core)
    core.register({ name: 'spec.hoc', id: 'outer' }, layer('outer') as never)
    await flush()
    mounts.mockClear()
    act(() => { setTone('calm') })
    expect(mounts).not.toHaveBeenCalled()

    act(() => { setTone('loud') })
    expect(view.container.querySelector('section')?.getAttribute('data-tone')).toBe('loud')
    expect(mounts).not.toHaveBeenCalled()

    const dispose = core.register({ name: 'spec.hoc', id: 'inner', order: 10 }, layer('inner') as never)
    await flush()
    expect(mounts).toHaveBeenCalledOnce()
    dispose()
    await flush()
    expect(view.container.querySelector('section[data-layer="inner"]')).toBeNull()
    expect(view.getByTestId('content')).toBeTruthy()
  })

  it('skips a crashed layer: its content still renders and the layer leaves the slot', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const core = new SlotCore()
    const view = mount(core)
    core.register({ name: 'spec.hoc', id: 'outer' }, layer('outer') as never)
    core.register({ name: 'spec.hoc', id: 'broken', order: 10 }, (() => { throw new Error('layer failed') }) as never)
    await flush()
    await flush()
    expect(view.container.querySelector('section[data-layer="outer"] p')?.textContent).toBe('content')
    expect(view.container.querySelector('[data-slot-error]')).toBeNull()
    expect(core.entriesOfSlot('spec.hoc').map(entry => entry.options.id)).toEqual(['outer'])
    expect(error).toHaveBeenCalled()
  })

  it('passes content errors upward without blaming or removing any layer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const core = new SlotCore()
    const reported = vi.fn()
    core.onEntryError(reported)
    let failing = false
    function Fragile() {
      if (failing) throw new Error('content failed')
      return <p data-testid="fragile">fragile</p>
    }
    const caught = vi.fn()
    class Catch extends Component<{ children: ReactNode }, { error: unknown }> {
      override state: { error: unknown } = { error: undefined }
      static getDerivedStateFromError(error: unknown) { return { error } }
      override componentDidCatch(error: unknown) { caught(error) }
      override render() { return this.state.error === undefined ? this.props.children : <p data-testid="host-fallback" /> }
    }
    const view = mount(core, renderSlot => <Catch>{renderSlot('spec.hoc', { tone: 'calm' }, { children: <Fragile /> })}</Catch>)
    core.register({ name: 'spec.hoc', id: 'outer' }, layer('outer') as never)
    core.register({ name: 'spec.hoc', id: 'inner', order: 10 }, layer('inner') as never)
    await flush()
    failing = true
    act(() => { setTone('loud') })
    await flush()
    expect(view.getByTestId('host-fallback')).toBeTruthy()
    expect(caught).toHaveBeenCalledWith(expect.objectContaining({ message: 'content failed' }))
    expect(reported).not.toHaveBeenCalled()
    expect(core.entriesOfSlot('spec.hoc').map(entry => entry.options.id)).toEqual(['outer', 'inner'])
  })

  it('renders its layers around nothing when the owner omits children', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => renderSlot('spec.hoc', { tone: 'calm' }))
    core.register({ name: 'spec.hoc', id: 'outer' }, layer('outer') as never)
    await flush()
    expect(view.container.querySelector('section[data-layer="outer"]')?.childNodes).toHaveLength(0)
  })

  it('wraps content in session-maybe and strict session layers', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => (
      <>
        {renderSlot('spec.hoc.maybe', {}, { children: <Content label="maybe-content" /> })}
        {renderSlot('spec.hoc.session', {}, { children: <Content label="session-content" /> })}
      </>
    ))
    core.register({ name: 'spec.hoc.maybe', id: 'maybe' }, layer('maybe') as never)
    core.register({ name: 'spec.hoc.session', id: 'session' }, layer('session') as never)
    await flush()
    expect(view.container.querySelector('section[data-layer="maybe"] p')?.textContent).toBe('maybe-content')
    expect(view.container.querySelector('section[data-layer="session"] p')?.textContent).toBe('session-content')
  })
})
