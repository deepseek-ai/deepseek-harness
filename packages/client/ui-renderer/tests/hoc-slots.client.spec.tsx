// @vitest-environment jsdom
/**
 * Hoc slots over the real ui-slots SlotCore: nesting order, owner and
 * children delivery, remount semantics, crash containment, and every scope.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Component, useEffect, useState, type ReactNode } from 'react'
import {
  SlotCore, type PropsRenderSlots, type ScopedStandardSourceBinding, type SlotRendererHost,
  type SlotScopeAdapter, type StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots/client'
import { createSlotRenderer } from '../src/client/scoped-slots.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'spec.hoc': { kind: 'hoc'; scope: 'root'; owner: { tone: string } }
    'spec.hoc.maybe': { kind: 'hoc'; scope: 'session-maybe' }
    'spec.hoc.session': { kind: 'hoc'; scope: 'session' }
    'spec.hoc.keyed': { kind: 'hoc'; scope: 'root'; owner: { tone: string } }
    'spec.hoc.inline': { kind: 'hoc'; scope: 'root'; inline: true }
    'spec.hoc.receiver': { kind: 'hoc'; scope: 'root' }
  }
}

type Frame = PropsRenderSlots<'spec.hoc' | 'spec.hoc.maybe' | 'spec.hoc.session' | 'spec.hoc.keyed' | 'spec.hoc.inline'>

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

/** A direct path through the children outlets of the given wrapping layers, outermost first. */
function layerContent(...ids: string[]): string {
  return ids.map(id => `section[data-layer="${id}"] > [data-slot-children]`).join(' > ')
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
      'spec.hoc.keyed': { kind: 'hoc', scope: 'root' },
      'spec.hoc.inline': { kind: 'hoc', scope: 'root', inline: true },
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
    const anchor = view.container.querySelector('[data-slot="spec.hoc"]')!
    expect(anchor.firstElementChild).toBe(view.getByTestId('content'))
    expect(anchor.querySelector('[data-slot-children]')).toBeNull()

    core.register({ name: 'spec.hoc', id: 'inner', order: 10 }, layer('inner') as never)
    core.register({ name: 'spec.hoc', id: 'outer' }, layer('outer') as never)
    await flush()
    const outer = anchor.querySelector(':scope > section[data-layer="outer"]')
    const inner = outer?.querySelector(':scope > [data-slot-children="spec.hoc"] > section[data-layer="inner"]')
    expect(inner?.querySelector(':scope > [data-slot-children="spec.hoc"] > p')).toBe(view.getByTestId('content'))
    const outlets = Array.from(anchor.querySelectorAll<HTMLElement>('[data-slot-children]'))
    expect(outlets.map(node => [node.tagName, node.style.display])).toEqual([['DIV', 'contents'], ['DIV', 'contents']])
    expect(outer?.getAttribute('data-tone')).toBe('calm')
    expect(inner?.getAttribute('data-tone')).toBe('calm')
  })

  it('keeps each supplying slot name when a layer forwards its children through another hoc slot', async () => {
    const core = new SlotCore()
    const view = mount(core)
    core.register({
      name: 'spec.hoc', id: 'bridge',
      children: { 'spec.hoc.receiver': { kind: 'hoc', scope: 'root' } },
    }, ({ renderSlot, children }) => renderSlot('spec.hoc.receiver', {}, {
      children: <>{children}<p>Added for the receiver</p></>,
    }))
    core.register({ name: 'spec.hoc', id: 'pass', order: 1 }, ({ children }) => children)
    core.register({ name: 'spec.hoc.receiver', id: 'pass' }, ({ children }) => children)
    await flush()

    const content = view.getByTestId('content')
    const extra = view.getByText('Added for the receiver')
    const receiver = view.container.querySelector('[data-slot="spec.hoc"] > [data-slot="spec.hoc.receiver"]')!
    expect(content.closest('[data-slot]')).toBe(receiver)
    expect(extra.closest('[data-slot]')).toBe(receiver)
    expect(receiver.querySelector([
      ':scope', '[data-slot-children="spec.hoc.receiver"]',
      '[data-slot-children="spec.hoc"]', '[data-slot-children="spec.hoc"]', 'p',
    ].join(' > '))).toBe(content)
    expect([...receiver.querySelectorAll('[data-slot-children] > p')]).toEqual([content, extra])
    expect([...receiver.querySelectorAll('[data-slot-children="spec.hoc"] > p')]).toEqual([content])
    expect([...receiver.querySelectorAll('[data-slot-children="spec.hoc.receiver"] > p')]).toEqual([extra])
  })

  it('keeps the selected layers and their slot names separate when two slots share one declaration object', () => {
    const core = new SlotCore()
    const shared = { kind: 'hoc', scope: 'root' } as const
    core.register({ name: 'root', children: { 'spec.hoc': shared, 'spec.hoc.keyed': shared } }, ({ renderSlot }) => <>
      {renderSlot('spec.hoc', { tone: 'first' }, { entryKey: 'same', children: 'First' })}
      {renderSlot('spec.hoc.keyed', { tone: 'second' }, { entryKey: 'same', children: 'Second' })}
    </>)
    core.register({ name: 'spec.hoc', key: 'same', id: 'wrap' }, layer('first'))
    core.register({ name: 'spec.hoc.keyed', key: 'same', id: 'wrap' }, layer('second'))
    const view = render(<>{createSlotRenderer().renderRoot(hostOver(core), {})}</>)

    for (const [slot, id, text] of [['spec.hoc', 'first', 'First'], ['spec.hoc.keyed', 'second', 'Second']]) {
      const outlet = view.container.querySelector(`[data-slot="${slot}"] > section[data-layer="${id}"] > [data-slot-children="${slot}"]`)
      expect(outlet?.textContent).toBe(text)
    }
  })

  it('groups inline owner content without enclosing the extra control returned by the layer', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => renderSlot('spec.hoc.inline', {}, {
      children: <><em>First</em>Second</>,
    }))
    core.register({ name: 'spec.hoc.inline', id: 'action' }, ({ children }) => <>{children}<button>Action</button></>)
    await flush()
    const anchor = view.container.querySelector('[data-slot="spec.hoc.inline"]')!
    const outlet = anchor.querySelector<HTMLElement>(':scope > [data-slot-children="spec.hoc.inline"]')
    expect(outlet?.tagName).toBe('SPAN')
    expect(outlet?.style.display).toBe('contents')
    expect(outlet?.firstChild).toBe(view.getByText('First'))
    expect(outlet?.lastChild?.textContent).toBe('Second')
    expect([...anchor.children]).toEqual([outlet, view.getByRole('button', { name: 'Action' })])
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

  it('contains a crashed layer to its occurrence: content renders there and the layer stays for other occurrences', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const core = new SlotCore()
    const reported = vi.fn()
    core.onEntryError(reported)
    const view = mount(core, renderSlot => (
      <>
        <div data-testid="calm-outlet">{renderSlot('spec.hoc', { tone: 'calm' }, { children: <Content label="calm-content" /> })}</div>
        <div data-testid="loud-outlet">{renderSlot('spec.hoc', { tone: 'loud' }, { children: <Content label="loud-content" /> })}</div>
      </>
    ))
    core.register({ name: 'spec.hoc', id: 'outer' }, layer('outer') as never)
    core.register({ name: 'spec.hoc', id: 'fragile', order: 10 }, (({ tone, children }: { tone: string; children: ReactNode }) => {
      if (tone === 'loud') throw new Error('layer failed')
      return <section data-layer="fragile">{children}</section>
    }) as never)
    await flush()
    await flush()
    const loud = view.getByTestId('loud-outlet')
    expect(loud.querySelector(`${layerContent('outer')} > [data-slot-children="spec.hoc"] > p`)?.textContent).toBe('loud-content')
    expect(loud.querySelector('section[data-layer="fragile"]')).toBeNull()
    const calm = view.getByTestId('calm-outlet')
    expect(calm.querySelector(`${layerContent('outer', 'fragile')} > p`)?.textContent).toBe('calm-content')
    expect(view.container.querySelector('[data-slot-error]')).toBeNull()
    expect(core.entriesOfSlot('spec.hoc').map(entry => entry.options.id)).toEqual(['outer', 'fragile'])
    expect(reported).toHaveBeenCalledWith('spec.hoc', expect.anything(), expect.objectContaining({ message: 'layer failed' }), { abdicated: false })
    expect(error).toHaveBeenCalled()
  })

  it('a crashed occurrence does not retry while it stays mounted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const core = new SlotCore()
    let ownerTone = 'loud'
    let shown = true
    const view = mount(core, renderSlot => (shown
      ? renderSlot('spec.hoc', { tone: ownerTone }, { children: <Content label="retry-content" /> })
      : false))
    const calls = vi.fn()
    core.register({ name: 'spec.hoc', id: 'fragile' }, (({ tone, children }: { tone: string; children: ReactNode }) => {
      calls(tone)
      if (tone === 'loud') throw new Error('layer failed')
      return <section data-layer="fragile">{children}</section>
    }) as never)
    await flush()
    expect(calls).toHaveBeenCalledWith('loud')
    expect(view.getByTestId('retry-content')).toBeTruthy()
    calls.mockClear()

    act(() => { setTone('same-owner') })
    expect(calls).not.toHaveBeenCalled()
    ownerTone = 'calm'
    act(() => { setTone('changed-owner') })
    expect(calls).not.toHaveBeenCalled()
    expect(view.getByTestId('retry-content')).toBeTruthy()
    expect(view.container.querySelector('section[data-layer="fragile"]')).toBeNull()

    shown = false
    act(() => { setTone('unmounted') })
    expect(view.queryByTestId('retry-content')).toBeNull()
    shown = true
    act(() => { setTone('remounted') })
    expect(calls).toHaveBeenCalledWith('calm')
    expect(view.container.querySelector(`${layerContent('fragile')} > p`)?.textContent).toBe('retry-content')
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

  it('keeps a forwarded children outlet empty when the owner supplies no content', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => renderSlot('spec.hoc', { tone: 'calm' }))
    core.register({ name: 'spec.hoc', id: 'outer' }, layer('outer') as never)
    await flush()
    const outer = view.container.querySelector('section[data-layer="outer"]')!
    expect(outer.childNodes).toHaveLength(1)
    expect(outer.firstElementChild?.matches('div[data-slot-children="spec.hoc"]:empty')).toBe(true)
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
    expect(view.getByTestId('maybe-content').parentElement?.getAttribute('data-slot-children')).toBe('spec.hoc.maybe')
    expect(view.getByTestId('session-content').parentElement?.getAttribute('data-slot-children')).toBe('spec.hoc.session')
  })
})

function keyedOutlet(renderSlot: Frame['renderSlot'], entryKey: string, label: string) {
  return (
    <div data-testid={`${label}-outlet`}>
      {renderSlot('spec.hoc.keyed', { tone: 'x' }, { entryKey, children: <Content label={label} /> })}
    </div>
  )
}

describe('keyed hoc slots', () => {
  it('applies wildcard layers to every key and exact-key layers only to their key', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => (
      <>
        {keyedOutlet(renderSlot, 'ts', 'ts-content')}
        {keyedOutlet(renderSlot, 'md', 'md-content')}
      </>
    ))
    core.register({ name: 'spec.hoc.keyed', id: 'w' }, layer('w') as never)
    core.register({ name: 'spec.hoc.keyed', id: 'ts', key: 'ts', order: 1 }, layer('ts') as never)
    await flush()
    const ts = view.getByTestId('ts-content-outlet')
    expect(ts.querySelector(`${layerContent('w', 'ts')} > p`)?.textContent).toBe('ts-content')
    const md = view.getByTestId('md-content-outlet')
    expect(md.querySelector(`${layerContent('w')} > p`)?.textContent).toBe('md-content')
    expect(md.querySelector('section[data-layer="ts"]')).toBeNull()
  })

  it('omitted entryKey applies only wildcard layers', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => renderSlot('spec.hoc.keyed', { tone: 'x' }, { children: <Content label="wild-content" /> }))
    core.register({ name: 'spec.hoc.keyed', id: 'w' }, layer('w') as never)
    core.register({ name: 'spec.hoc.keyed', id: 'ts', key: 'ts', order: 1 }, layer('ts') as never)
    await flush()
    expect(view.container.querySelector(`${layerContent('w')} > p`)?.textContent).toBe('wild-content')
    expect(view.container.querySelector('section[data-layer="ts"]')).toBeNull()
  })

  it('an exact-key layer replaces the wildcard layer with the same id', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => (
      <>
        {keyedOutlet(renderSlot, 'ts', 'ts-content')}
        {keyedOutlet(renderSlot, 'md', 'md-content')}
      </>
    ))
    core.register({ name: 'spec.hoc.keyed', id: 'x' }, layer('wild') as never)
    core.register({ name: 'spec.hoc.keyed', id: 'x', key: 'ts' }, layer('exact') as never)
    await flush()
    const ts = view.getByTestId('ts-content-outlet')
    expect(ts.querySelector(`${layerContent('exact')} > p`)?.textContent).toBe('ts-content')
    expect(ts.querySelector('section[data-layer="wild"]')).toBeNull()
    const md = view.getByTestId('md-content-outlet')
    expect(md.querySelector(`${layerContent('wild')} > p`)?.textContent).toBe('md-content')
    expect(md.querySelector('section[data-layer="exact"]')).toBeNull()
  })

  it('a layer may skip its children, so the content never mounts', async () => {
    const core = new SlotCore()
    mounts.mockClear()
    let outletShown = false
    const view = mount(core, renderSlot => (outletShown ? keyedOutlet(renderSlot, 'ts', 'skipped-content') : null))
    core.register({ name: 'spec.hoc.keyed', id: 'replace', key: 'ts' }, (() => <i data-testid="replaced" />) as never)
    outletShown = true
    act(() => { setTone('loud') })
    await flush()
    expect(view.getByTestId('replaced').parentElement?.getAttribute('data-slot')).toBe('spec.hoc.keyed')
    expect(view.container.querySelector('[data-slot-children]')).toBeNull()
    expect(view.queryByTestId('skipped-content')).toBeNull()
    expect(mounts).not.toHaveBeenCalledWith('skipped-content')
  })

  it('a crashed keyed layer falls back to its children', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const core = new SlotCore()
    const view = mount(core, renderSlot => (
      <>
        {keyedOutlet(renderSlot, 'ts', 'ts-content')}
        <div data-testid="calm-outlet">
          {renderSlot('spec.hoc.keyed', { tone: 'calm' }, { entryKey: 'ts', children: <Content label="calm-content" /> })}
        </div>
      </>
    ))
    core.register({ name: 'spec.hoc.keyed', id: 'fragile', key: 'ts' }, (({ tone, children }: { tone: string; children: ReactNode }) => {
      if (tone === 'x') throw new Error('layer failed')
      return <section data-layer="fragile">{children}</section>
    }) as never)
    await flush()
    await flush()
    expect(view.getByTestId('ts-content').textContent).toBe('ts-content')
    expect(view.getByTestId('ts-content-outlet').querySelector('section[data-layer="fragile"]')).toBeNull()
    expect(view.getByTestId('calm-outlet').querySelector(`${layerContent('fragile')} > p`)?.textContent).toBe('calm-content')
    expect(core.entriesOfSlot('spec.hoc.keyed').map(entry => [entry.options.key, entry.options.id])).toEqual([['ts', 'fragile']])
  })

  it('interleaves wildcard and exact-key layers by order', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => (
      <>
        {keyedOutlet(renderSlot, 'ts', 'ts-content')}
        {keyedOutlet(renderSlot, 'md', 'md-content')}
      </>
    ))
    core.register({ name: 'spec.hoc.keyed', id: 'w2', order: 2 }, layer('w2') as never)
    core.register({ name: 'spec.hoc.keyed', id: 'e1', key: 'ts', order: 1 }, layer('e1') as never)
    core.register({ name: 'spec.hoc.keyed', id: 'w0', order: 0 }, layer('w0') as never)
    await flush()
    const ts = view.getByTestId('ts-content-outlet')
    expect(ts.querySelector(`${layerContent('w0', 'e1', 'w2')} > p`)?.textContent)
      .toBe('ts-content')
    const md = view.getByTestId('md-content-outlet')
    expect(md.querySelector(`${layerContent('w0', 'w2')} > p`)?.textContent).toBe('md-content')
    expect(md.querySelector('section[data-layer="e1"]')).toBeNull()
  })

  it('a lower-priority registration at the same key and id shadows the layer until disposed', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => keyedOutlet(renderSlot, 'ts', 'ts-content'))
    core.register({ name: 'spec.hoc.keyed', id: 'w0', order: 0 }, layer('w0') as never)
    core.register({ name: 'spec.hoc.keyed', id: 'e1', key: 'ts', order: 1 }, layer('e1') as never)
    await flush()
    const dispose = core.register({ name: 'spec.hoc.keyed', id: 'e1', key: 'ts', order: 1, priority: -1 }, layer('shadow') as never)
    await flush()
    const ts = view.getByTestId('ts-content-outlet')
    expect(ts.querySelector(`${layerContent('w0', 'shadow')} > p`)?.textContent).toBe('ts-content')
    expect(ts.querySelector('section[data-layer="e1"]')).toBeNull()
    dispose()
    await flush()
    expect(ts.querySelector(`${layerContent('w0', 'e1')} > p`)?.textContent).toBe('ts-content')
    expect(ts.querySelector('section[data-layer="shadow"]')).toBeNull()
  })

  it('an outer wildcard layer still wraps an exact-key layer that skips its children', async () => {
    const core = new SlotCore()
    const view = mount(core, renderSlot => keyedOutlet(renderSlot, 'ts', 'ts-content'))
    mounts.mockClear()
    core.register({ name: 'spec.hoc.keyed', id: 'w0', order: 0 }, layer('w0') as never)
    core.register({ name: 'spec.hoc.keyed', id: 'replace', key: 'ts', order: 1 }, (() => <i data-testid="replaced" />) as never)
    core.register({ name: 'spec.hoc.keyed', id: 'w2', order: 2 }, layer('w2') as never)
    await flush()
    const ts = view.getByTestId('ts-content-outlet')
    expect(ts.querySelector(`${layerContent('w0')} > i[data-testid="replaced"]`)).not.toBeNull()
    expect(ts.querySelector('section[data-layer="w2"]')).toBeNull()
    expect(view.queryByTestId('ts-content')).toBeNull()
    expect(mounts).not.toHaveBeenCalledWith('ts-content')
  })

  it('registering a layer for another key keeps this key\'s content mounted', async () => {
    const core = new SlotCore()
    mounts.mockClear()
    const view = mount(core, renderSlot => keyedOutlet(renderSlot, 'ts', 'ts-content'))
    core.register({ name: 'spec.hoc.keyed', id: 'w' }, layer('w') as never)
    await flush()
    const before = mounts.mock.calls.length
    act(() => { core.register({ name: 'spec.hoc.keyed', id: 'md', key: 'md' }, layer('md') as never) })
    await flush()
    expect(mounts).toHaveBeenCalledTimes(before)
    act(() => { core.register({ name: 'spec.hoc.keyed', id: 'ts2', key: 'ts' }, layer('ts2') as never) })
    await flush()
    expect(mounts).toHaveBeenCalledTimes(before + 1)
    expect(view.container.querySelector(`${layerContent('ts2')} > p`)?.textContent).toBe('ts-content')
  })

  it('keeps every outlet of a key mounted when another key registers', async () => {
    const core = new SlotCore()
    mounts.mockClear()
    const view = mount(core, renderSlot => (
      <>
        {keyedOutlet(renderSlot, 'ts', 'first-content')}
        {keyedOutlet(renderSlot, 'ts', 'second-content')}
      </>
    ))
    core.register({ name: 'spec.hoc.keyed', id: 'w' }, layer('w') as never)
    await flush()
    const before = mounts.mock.calls.length
    act(() => { core.register({ name: 'spec.hoc.keyed', id: 'md', key: 'md' }, layer('md') as never) })
    await flush()
    expect(mounts).toHaveBeenCalledTimes(before)
    expect(view.getByTestId('first-content-outlet').querySelector(`${layerContent('w')} > p`)?.textContent).toBe('first-content')
    expect(view.getByTestId('second-content-outlet').querySelector(`${layerContent('w')} > p`)?.textContent).toBe('second-content')
  })

  it('recompiles a key\'s chain for a redeclared slot', async () => {
    const core = new SlotCore()
    const declare = () => core.register({
      name: 'root',
      children: { 'spec.hoc.keyed': { kind: 'hoc', scope: 'root' } },
    }, function Root(props: Frame) {
      return <>{keyedOutlet(props.renderSlot, 'ts', 'ts-content')}</>
    } as never)
    const undeclare = declare()
    const view = render(<>{createSlotRenderer().renderRoot(hostOver(core), {})}</>)
    core.register({ name: 'spec.hoc.keyed', id: 'first', key: 'ts' }, layer('first') as never)
    await flush()
    expect(view.container.querySelector(`${layerContent('first')} > p`)?.textContent).toBe('ts-content')
    act(() => {
      undeclare()
      declare()
      core.register({ name: 'spec.hoc.keyed', id: 'second', key: 'ts' }, layer('second') as never)
    })
    await flush()
    expect(view.container.querySelector(`${layerContent('second')} > p`)?.textContent).toBe('ts-content')
    expect(view.container.querySelector('section[data-layer="first"]')).toBeNull()
  })
})
