// @vitest-environment jsdom
/** The default preview owns each native attempt and reports native unavailability to the document preview. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createPresentationStore } from '../src/client/presentation-store.ts'
import { Preview as PreviewBody, type PreviewProps } from '../src/client/Preview.tsx'
import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'
import { RetainedViews } from '../src/client/RetainedViews.tsx'
import { RetainedOfficeViews } from '../src/client/retained-views.ts'

vi.mock('../src/client/View.tsx', () => ({ OfficeView: (props: {
  onFailure?: (error?: unknown) => void
  onLoaded?: (version: string) => void
  registerPresentation?: (tab: never, action: never) => () => void
}) => <div><span>read-only preview</span>
  <button aria-label="Native loaded" onClick={() => { props.onLoaded?.('native-version') }} />
  <button aria-label="Register playback" onClick={() => { props.registerPresentation?.('tab' as never, { play: () => {} } as never)() }} />
  <button onClick={props.onFailure}>Native failure</button>
  <button onClick={() => { props.onFailure?.(); props.onFailure?.() }}>Repeated native failure</button></div> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Preview({ detached = false, ...props }: PreviewProps & { readonly detached?: boolean }) {
  return <><RetainedViews useViews={observableHook(props.office.views)} />{detached ? null : <PreviewBody {...props} />}</>
}

function fixture() {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const signal = new AbortController().signal
  const office: PreviewProps['office'] = { views: new RetainedOfficeViews(), connection: {} as PreviewProps['office']['connection'] }
  const partial: Partial<PreviewProps> = {
    resourceAddress: 'dsh-resource://file/session/fixture/file.docx',
    content: { kind: 'renderer', revision: 1, loaded: vi.fn(), failed: vi.fn(), reload: vi.fn() },
    onNativeUnavailable: vi.fn(), office,
    t: key => key, actions: createPresentationStore().create().actions,
    useTabInfo: () => ({ tab: { signal, visible: true } }) as ReturnType<PreviewProps['useTabInfo']>,
  }
  return { props: partial as PreviewProps }
}

test('a native failure reports unavailability synchronously and the attempt stays closed until the source revision changes', () => {
  const { props } = fixture()
  const view = render(<Preview {...props} />)
  expect(props.onNativeUnavailable).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Native failure' }))
  expect(props.onNativeUnavailable).toHaveBeenCalledOnce()
  expect(screen.queryByText('read-only preview')).toBeNull()
  view.rerender(<Preview {...props} />)
  expect(screen.queryByText('read-only preview')).toBeNull()
  expect(props.onNativeUnavailable).toHaveBeenCalledOnce()
  const retry = vi.fn()
  view.rerender(<Preview {...props} onNativeUnavailable={retry} content={{ ...props.content, kind: 'renderer', revision: 2,
    loaded: vi.fn(), failed: vi.fn(), reload: vi.fn() }} />)
  expect(screen.getByText('read-only preview')).toBeDefined()
  expect(retry).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Native failure' }))
  expect(retry).toHaveBeenCalledOnce()
  expect(props.onNativeUnavailable).toHaveBeenCalledOnce()
})

test('repeated failures of one attempt report unavailability once', () => {
  const { props } = fixture()
  render(<Preview {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Repeated native failure' }))
  expect(props.onNativeUnavailable).toHaveBeenCalledOnce()
})

test('a remounted sidebar body keeps the failed attempt without opening or reporting again', () => {
  const { props } = fixture()
  const view = render(<Preview {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Native failure' }))
  view.rerender(<Preview {...props} detached />)
  view.rerender(<Preview {...props} />)
  expect(screen.queryByText('read-only preview')).toBeNull()
  expect(props.onNativeUnavailable).toHaveBeenCalledOnce()
})

test('a re-rendered owner with unchanged values does not republish the retained body', () => {
  const { props } = fixture()
  const listener = vi.fn()
  props.office.views.subscribe(listener)
  const view = render(<Preview {...props} />)
  listener.mockClear()
  view.rerender(<Preview {...props} />)
  view.rerender(<Preview {...props} />)
  expect(listener).not.toHaveBeenCalled()
})

test('native readiness reports the source version and owns the presentation action', () => {
  const { props } = fixture()
  const present = vi.spyOn(props.actions, 'present'), retire = vi.spyOn(props.actions, 'retire')
  render(<Preview {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Native loaded' }))
  expect(props.content.kind === 'renderer' && props.content.loaded).toHaveBeenCalledWith('native-version')
  fireEvent.click(screen.getByRole('button', { name: 'Register playback' }))
  expect(present).toHaveBeenCalledOnce(); expect(retire).toHaveBeenCalledOnce()
})

test('byte-backed content retains its native attempt without a renderer version observer', () => {
  const { props } = fixture()
  render(<Preview {...props} content={{ kind: 'bytes', data: new Uint8Array() }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Native loaded' }))
  expect(screen.getByText('read-only preview')).toBeDefined()
})

test('a hidden attempt reports its failure while detached from the sidebar', () => {
  const { props } = fixture()
  const useTabInfo = () => { const info = props.useTabInfo(); return { ...info, tab: { ...info.tab, visible: false } } }
  render(<Preview {...props} useTabInfo={useTabInfo} />)
  fireEvent.click(screen.getByRole('button', { name: 'Native failure' }))
  expect(props.onNativeUnavailable).toHaveBeenCalledOnce()
  expect(screen.queryByText('read-only preview')).toBeNull()
})
