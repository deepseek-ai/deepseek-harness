// @vitest-environment jsdom
/** Plugin lifecycle and feedback outlive the source component. */
import { File as NodeFile } from 'node:buffer'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { DraggableImage } from '@deepseek-ai/dsh-client-ui-primitives'
import { FILE_DRAG_TOKEN_TYPE, type DesktopFileDrag, type FileDragHandle } from '@deepseek-ai/dsh-util-file-drag'
import * as plugin from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
const revokeUrl = vi.fn<(url: string) => void>()

function transfer(token = ''): DataTransfer {
  const data = new Map([[FILE_DRAG_TOKEN_TYPE, token]])
  return Object.assign({} as DataTransfer, {
    items: { clear: vi.fn() }, effectAllowed: 'none',
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => { data.set(type, value) },
  })
}

async function bench(language: 'zh' | 'en' | 'ja' = 'zh') {
  revokeUrl.mockReset()
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:transfer'), revokeObjectURL: revokeUrl }))
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  onTestFinished(locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }))
  locale.setLocale(language)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const owner = await runtime.mount(plugin)
  await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } },
    ({ renderSlot }) => renderSlot('shell.overlay', {}))
  const view = runtime.renderRoot()
  return { runtime, owner, view, service: runtime.ctx.fileDrag }
}

it('keeps the Host entry empty', () => { applyHost() })

it('retains bytes after source unmount and releases on the detached node dragend', async () => {
  const { service, owner, runtime } = await bench()
  const file = new File(['pdf-original'], '报告.pdf', { type: 'application/pdf' })
  const source = render(<DraggableImage fileDrag={service.actions} src="blob:original" name={file.name} original={file} alt="original" />)
  const node = source.getByRole('img')
  const data = transfer()
  expect(service.read(data)).toBeUndefined()
  await act(async () => { fireEvent.pointerEnter(node) })
  fireEvent.dragStart(node, { dataTransfer: data })
  source.unmount()
  const received = service.read(data)!
  expect(received.name).toBe(file.name)
  expect(await received.text()).toBe('pdf-original')
  expect(data.getData('DownloadURL')).toBe('application/pdf:报告.pdf:blob:transfer')
  expect(service.read(transfer('foreign'))).toBeUndefined()
  node.dispatchEvent(new Event('dragend'))
  expect(service.read(data)).toBeUndefined()
  expect(revokeUrl).toHaveBeenCalledWith('blob:transfer')
  await owner.dispose()
  expect(runtime.ctx.get('fileDrag')).toBeUndefined()
  expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
})

it.each([
  ['zh', '拖放失败，请重试'],
  ['en', 'Drag failed. Try again.'],
  ['ja', 'ドラッグ＆ドロップに失敗しました。もう一度お試しください。'],
] as const)('reports a late native failure after source unmount in %s', async (language, message) => {
  const pending = Promise.withResolvers<boolean>()
  const handle = 'handle' as FileDragHandle
  const desktop: DesktopFileDrag = {
    prepare: vi.fn(async () => handle), cancel: vi.fn(), start: vi.fn(() => pending.promise), release: vi.fn(),
  }
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, fileDrag: desktop })
  const { service } = await bench(language)
  vi.stubGlobal('dshDesktop', { protocolVersion: 2 })
  const file = new File(['image'], 'image.png', { type: 'image/png' })
  const source = render(<DraggableImage fileDrag={service.actions} src="blob:original" name={file.name} original={file} alt="original" />)
  await act(async () => { fireEvent.pointerEnter(source.getByRole('img')) })
  fireEvent.dragStart(source.getByRole('img'), { dataTransfer: transfer() })
  source.unmount()
  expect(desktop.release).not.toHaveBeenCalled()
  vi.useFakeTimers()
  await act(async () => { pending.resolve(false); await pending.promise })
  expect(desktop.release).toHaveBeenCalledWith(handle)
  expect(screen.getByRole('alert').textContent).toBe(message)
  await act(async () => { await vi.runAllTimersAsync() })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('ignores an unsupported desktop protocol and removes feedback with the plugin', async () => {
  vi.stubGlobal('dshDesktop', { protocolVersion: 2, fileDrag: {} })
  const { service, owner } = await bench()
  act(() => { service.actions.reportFailure() })
  expect(screen.getByRole('alert')).toBeTruthy()
  await owner.dispose()
  expect(screen.queryByRole('alert')).toBeNull()
})
