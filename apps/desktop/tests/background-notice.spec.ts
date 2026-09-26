import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopBackgroundNotice } from '../src/background-notice.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-notice-'))
  roots.push(root)
  const markerPath = join(root, 'background-close-confirmed')
  const response = Promise.withResolvers<MessageBoxReturnValue>()
  const show = vi.fn<(options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(() => response.promise)
  const focus = vi.fn()
  const hide = vi.fn()
  const options = { markerPath, locale: () => resolveDesktopLocale('zh'), show, focus }
  return { root, markerPath, response, show, focus, hide, options, notice: new DesktopBackgroundNotice(options) }
}

it('keeps the window visible until confirmation and remembers acknowledgement across launches', async () => {
  const f = setup()
  writeFileSync(join(f.root, 'background-notice-shown'), '')
  f.notice.close(f.hide)
  f.notice.close(f.hide)
  expect(f.hide).not.toHaveBeenCalled()
  expect(existsSync(f.markerPath)).toBe(false)
  expect(f.show).toHaveBeenCalledExactlyOnceWith({ type: 'info', title: 'DeepSeek Harness',
    message: '正在运行的任务不会中断，可在系统托盘中重新打开窗口', buttons: ['确认'], defaultId: 0, cancelId: -1 })
  expect(f.focus).toHaveBeenCalledOnce()
  f.response.resolve({ response: 0, checkboxChecked: false })
  await vi.waitFor(() => { expect(f.hide).toHaveBeenCalledOnce() })
  expect(existsSync(f.markerPath)).toBe(true)
  new DesktopBackgroundNotice(f.options).close(f.hide)
  expect(f.hide).toHaveBeenCalledTimes(2)
  expect(f.show).toHaveBeenCalledOnce()
})

it('keeps cancellation eligible for another close and never records it', async () => {
  const f = setup()
  f.notice.close(f.hide)
  f.response.resolve({ response: -1, checkboxChecked: false })
  await f.response.promise
  expect(f.hide).not.toHaveBeenCalled()
  expect(existsSync(f.markerPath)).toBe(false)
  f.show.mockResolvedValue({ response: 0, checkboxChecked: false })
  f.notice.close(f.hide)
  await vi.waitFor(() => { expect(f.hide).toHaveBeenCalledOnce() })
  expect(f.show).toHaveBeenCalledTimes(2)
})

it('does not hide or record a late acknowledgement after disposal', async () => {
  const f = setup()
  f.notice.close(f.hide)
  f.notice.dispose()
  f.response.resolve({ response: 0, checkboxChecked: false })
  await f.response.promise
  f.notice.close(f.hide)
  expect(f.hide).not.toHaveBeenCalled()
  expect(existsSync(f.markerPath)).toBe(false)
  expect(f.show).toHaveBeenCalledOnce()
})

it('keeps acknowledgement in memory when its marker cannot be written', async () => {
  const f = setup()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  writeFileSync(join(f.root, 'blocker'), '')
  const notice = new DesktopBackgroundNotice({ ...f.options, markerPath: join(f.root, 'blocker', 'confirmed') })
  notice.close(f.hide)
  f.response.resolve({ response: 0, checkboxChecked: false })
  await vi.waitFor(() => { expect(f.hide).toHaveBeenCalledOnce() })
  notice.close(f.hide)
  expect(f.hide).toHaveBeenCalledTimes(2)
  expect(f.show).toHaveBeenCalledOnce()
  expect(console.warn).toHaveBeenCalledWith('desktop tray: could not record background confirmation', expect.anything())
})

it('keeps the window visible after a dialog failure and permits another attempt', async () => {
  const f = setup()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.notice.close(f.hide)
  f.response.reject(new Error('dialog unavailable'))
  await vi.waitFor(() => { expect(console.warn).toHaveBeenCalled() })
  expect(f.hide).not.toHaveBeenCalled()
  expect(existsSync(f.markerPath)).toBe(false)
  f.show.mockResolvedValue({ response: 0, checkboxChecked: false })
  f.notice.close(f.hide)
  await vi.waitFor(() => { expect(f.hide).toHaveBeenCalledOnce() })
})
