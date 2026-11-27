// @vitest-environment jsdom
/**
 * Integration against the real ui-slots SlotCore through a passthrough host:
 * registrations go through the real register() (options form, children
 * declaration), and the outlets ride the real subscribe/getVersion/entries/
 * isLive APIs — microtask-batched notifications, mutation-stable entry
 * references (the cache axis), and ledger-fed stale bindings are the
 * real-core semantics the fake-host suite cannot vouch for.
 */
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import {
  SlotCore, StaleAuthorizationError, type PropsRenderSlots, type SlotRendererHost,
  type SlotScopeAdapter, type StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots/client'
import { createSlotRenderer } from '../src/client/scoped-slots.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    // No 'root' merge: the aggregate client program already carries runtime's
    // authoritative 'root' declaration (a private merge would TS2717-collide);
    // only this suite's own test keys merge here.
    'spec.single': { kind: 'single'; scope: 'root'; owner: { label?: string } }
    'spec.list': { kind: 'list'; scope: 'root' }
  }
}

type FrameSlots = PropsRenderSlots<'spec.single' | 'spec.list'>

/** Passthrough host over the real core (store/session seats unused here). */
function hostOver(core: SlotCore): SlotRendererHost {
  const absentBinding: StandardSourceBinding = {
    key: undefined,
    hooks: {},
    keyedHooks: {},
    props: {},
  }
  const bindingSource = {
    getSnapshot: () => absentBinding,
    subscribe: () => () => {},
  }
  const sessionAdapter: SlotScopeAdapter = {
    current: bindingSource,
    bindingSource: () => bindingSource,
  }
  return {
    subscribe: (key, fn) => core.subscribe(key, fn),
    getVersion: key => core.getVersion(key),
    entriesOf: key => core.entries(key),
    entriesOfSlot: key => core.entriesOfSlot(key),
    reportEntryError: (key, entry, error, info) => { core.reportEntryError(key, entry, error, info) },
    reportFactoryError: (name, definition, error) => { core.reportFactoryError(name, definition, error) },
    specOf: key => core.specDynamic(key),
    isLive: entry => core.isLive(entry),
    storeOf: () => undefined,
    factoryStoreOf: () => undefined,
    retainFactoryOccurrence: () => () => {},
    subscribeFactory: (name, fn) => core.subscribeFactory(name, fn),
    getFactoryVersion: name => core.factoryVersion(name),
    factoryOf: name => core.factory(name),
    isFactoryLive: definition => core.isFactoryLive(definition),
    root: bindingSource,
    scopeRevision: { getSnapshot: () => 0, subscribe: () => () => {} },
    scope: () => sessionAdapter,
  }
}

/** Register the root frame (declaring both child keys) and mount the renderer. */
function mountFrame(core: SlotCore, body: (renderSlot: FrameSlots['renderSlot']) => React.ReactNode) {
  const dispose = core.register({
    name: 'root',
    children: {
      'spec.single': { kind: 'single', scope: 'root' },
      'spec.list': { kind: 'list', scope: 'root' },
    },
  }, (props: FrameSlots) => <>{body(props.renderSlot)}</>)
  const view = render(<>{createSlotRenderer().renderRoot(hostOver(core), {})}</>)
  return { view, dispose }
}

describe('createSlotRenderer over the real SlotCore', () => {
  it('renders registrations live through real microtask batching: register, dispose back to fallback', async () => {
    const core = new SlotCore()
    const { view } = mountFrame(core, renderSlot =>
      renderSlot('spec.single', {}, { fallback: <i>none</i> }))
    expect(view.container.textContent).toBe('none')
    let dispose = () => {}
    // The real core batches subscriber notification per microtask: async act.
    await act(async () => {
      dispose = core.register({ name: 'spec.single' }, ({ label }: { label?: string }) => <b>{label ?? 'on'}</b>)
    })
    expect(view.container.textContent).toBe('on')
    await act(async () => { dispose(); dispose() })   // disposer is idempotent in the real core
    expect(view.container.textContent).toBe('none')
  })

  it('coalesces same-tick mutations into one notification (uSES pairing stays consistent)', async () => {
    const core = new SlotCore()
    const notified = vi.fn()
    core.subscribe('spec.list', notified)
    const { view } = mountFrame(core, renderSlot => renderSlot('spec.list', {}))
    await act(async () => {
      core.register({ name: 'spec.list', id: 'two', order: 2 }, () => <span>2</span>)
      core.register({ name: 'spec.list', id: 'one', order: 1 }, () => <span>1</span>)
    })
    expect(notified).toHaveBeenCalledTimes(1)   // two same-tick mutations, one batch
    expect(view.container.textContent).toBe('12')
  })

  it('gives each list winner one root, including filtered, text, Fragment and empty results', async () => {
    const core = new SlotCore()
    const { view } = mountFrame(core, renderSlot => <>
      {renderSlot('spec.list', {}, { fallback: <i>fallback</i> })}
      {renderSlot('spec.list', {}, { only: 'pair', fallback: <i>no match</i> })}
    </>)
    const [all, only] = Array.from(view.container.querySelectorAll<HTMLElement>('[data-slot="spec.list"]'))
    expect(all!.innerHTML).toBe('<i>fallback</i>')
    expect(only!.innerHTML).toBe('<i>no match</i>')
    await act(async () => { core.register({ name: 'spec.list', id: 'text' }, () => 'text') })
    expect(all!.children).toHaveLength(1)
    expect(only!.innerHTML).toBe('<i>no match</i>')
    await act(async () => {
      core.register({ name: 'spec.list', id: 'pair', order: 1 }, () => <><b>A</b><i>B</i></>)
      core.register({ name: 'spec.list', id: 'pair', priority: 1 }, () => 'shadowed')
      core.register({ name: 'spec.list', id: 'null', order: 2 }, () => null)
    })
    const roots = Array.from(all!.querySelectorAll<HTMLElement>(':scope > *'))
    expect(roots.map(row => row.innerHTML)).toEqual(['text', '<b>A</b><i>B</i>', ''])
    expect(roots.every(row => row.matches('div[data-slot-item]') && row.style.display === 'contents')).toBe(true)
    expect(only!.children).toHaveLength(1)
    expect(only!.firstElementChild?.outerHTML).toBe(roots[1]!.outerHTML)
  })

  it('keeps the winning row and its component state across reordering and only filters', async () => {
    const core = new SlotCore()
    function FilterableList({ renderSlot }: FrameSlots) {
      const [only, setOnly] = useState(false)
      return <>
        <button type="button" onClick={() => { setOnly(value => !value) }}>Filter counter</button>
        {renderSlot('spec.list', {}, only ? { only: 'counter' } : {})}
      </>
    }
    const { view } = mountFrame(core, renderSlot => <FilterableList renderSlot={renderSlot} />)
    function Count() {
      const [count, setCount] = useState(0)
      return <button type="button" onClick={() => { setCount(count + 1) }}>{count}</button>
    }
    await act(async () => {
      core.register({ name: 'spec.list', id: 'neighbor', order: 1 }, () => 'after')
      core.register({ name: 'spec.list', id: 'counter', order: 0 }, Count)
    })
    const button = view.getByRole('button', { name: '0' })
    const outlet = view.container.querySelector('[data-slot="spec.list"]')!
    const row = outlet.firstElementChild!
    expect(row.contains(button)).toBe(true)
    fireEvent.click(button)
    let remove = () => {}
    await act(async () => {
      remove = core.register({ name: 'spec.list', id: 'neighbor', priority: -1, order: -1 }, () => 'before')
    })
    expect(outlet.textContent).toBe('before1')
    expect(outlet.lastElementChild).toBe(row)
    await act(async () => { remove() })
    expect(outlet.textContent).toBe('1after')
    expect(outlet.firstElementChild).toBe(row)
    const toggle = view.getByRole('button', { name: 'Filter counter' })
    fireEvent.click(toggle)
    expect(outlet.children).toHaveLength(1)
    expect(outlet.firstElementChild).toBe(row)
    expect(view.getByRole('button', { name: '1' })).toBe(button)
    fireEvent.click(toggle)
    expect(outlet.textContent).toBe('1after')
    expect(outlet.firstElementChild).toBe(row)
    expect(view.getByRole('button', { name: '1' })).toBe(button)
  })

  it('passes owner props through and keeps sibling entries() references stable across mutations', async () => {
    const core = new SlotCore()
    core.register({ name: 'root', children: {
      'spec.single': { kind: 'single', scope: 'root' },
      'spec.list': { kind: 'list', scope: 'root' },
    } }, (props: FrameSlots) => <>
      {props.renderSlot('spec.single', { label: 'owner' })}
      {props.renderSlot('spec.list', {})}
    </>)
    core.register({ name: 'spec.single' }, ({ label }: { label?: string }) => <b>{label}</b>)
    const view = render(<>{createSlotRenderer().renderRoot(hostOver(core), {})}</>)
    expect(view.container.textContent).toBe('owner')
    // A mutation on the sibling key leaves this key's entries() reference
    // untouched (real-core stability the inject/renderSlot caches key on).
    const before = core.entries('spec.single')
    await act(async () => { core.register({ name: 'spec.list', id: 'l' }, () => <span>L</span>) })
    expect(core.entries('spec.single')).toBe(before)
    expect(view.container.textContent).toBe('ownerL')
  })

  it('feeds stale bindings from the real ledger: a disposed registration throws off isLive', () => {
    const core = new SlotCore()
    let captured: FrameSlots['renderSlot'] | undefined
    const { view, dispose } = mountFrame(core, (renderSlot) => {
      captured = renderSlot
      return null
    })
    expect(captured!('spec.single', {})).not.toBeUndefined()   // live binding renders
    // Unmount before disposing: an empty 'root' makes a LIVE root outlet
    // rethrow boot-order (covered in the fake-host suite); the scenario here
    // is a retained closure outliving both tree and registration.
    view.unmount()
    dispose()
    expect(() => captured!('spec.single', {})).toThrow(StaleAuthorizationError)
  })
})
