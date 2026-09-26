import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogReturnValue } from 'electron'
import { DESKTOP_IPC } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: (event: IpcMainInvokeEvent) => Promise<string | null>) => void>(),
  showOpenDialog: vi.fn<(window: BrowserWindow, options: unknown) => Promise<OpenDialogReturnValue>>(),
}))
vi.mock('electron', () => ({ ipcMain: { handle: electron.handle }, dialog: electron }))
const { installDesktopDirectoryPicker } = await import('../src/directory-picker.ts')

beforeEach(() => { vi.resetAllMocks() })

function fixture() {
  const frame = { url: 'dsh-app://app/' }
  const window = {
    webContents: { mainFrame: frame },
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
  let current: BrowserWindow | undefined = window as unknown as BrowserWindow
  installDesktopDirectoryPicker(() => current)
  expect(electron.handle.mock.calls[0]?.[0]).toBe(DESKTOP_IPC.directoryPick)
  const handler = electron.handle.mock.calls[0]![1]
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { window, frame, event, handler, detach: () => { current = undefined } }
}

describe('Desktop directory picker', () => {
  it('restores and focuses the parent window and shares an unanswered dialog', async () => {
    const f = fixture()
    f.window.isMinimized.mockReturnValue(true)
    let settle!: (value: OpenDialogReturnValue) => void
    electron.showOpenDialog.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    const first = f.handler(f.event)
    const second = f.handler(f.event)
    expect(electron.showOpenDialog).toHaveBeenCalledExactlyOnceWith(f.window, { properties: ['openDirectory', 'createDirectory'] })
    expect(f.window.restore).toHaveBeenCalledOnce()
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
    settle({ canceled: false, filePaths: ['/workspace'] })
    await expect(Promise.all([first, second])).resolves.toEqual(['/workspace', '/workspace'])
    electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(f.handler(f.event)).resolves.toBeNull()
    expect(electron.showOpenDialog).toHaveBeenCalledTimes(2)
  })

  it('releases a failed dialog so the user can retry', async () => {
    const f = fixture()
    electron.showOpenDialog.mockRejectedValueOnce(new Error('chooser failed'))
    await expect(f.handler(f.event)).rejects.toThrow('chooser failed')
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] })
    await expect(f.handler(f.event)).resolves.toBeNull()
  })

  it('discards the selected path after the parent is destroyed', async () => {
    const f = fixture()
    electron.showOpenDialog.mockImplementation(async () => {
      f.window.isDestroyed.mockReturnValue(true)
      return { canceled: false, filePaths: ['/workspace'] }
    })
    await expect(f.handler(f.event)).resolves.toBeNull()
  })

  it('rejects other windows, subframes, shell pages, remote pages, and missing windows', async () => {
    const f = fixture()
    await expect(f.handler({ ...f.event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('unowned renderer')
    await expect(f.handler({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent)).rejects.toThrow('unowned renderer')
    for (const url of ['dsh-app://shell/startup.html', 'https://example.com/', 'http://127.0.0.1/']) {
      f.frame.url = url
      await expect(f.handler(f.event)).rejects.toThrow('unowned renderer')
    }
    f.window.isDestroyed.mockReturnValue(true)
    await expect(f.handler(f.event)).rejects.toThrow('unowned renderer')
    f.detach()
    await expect(f.handler(f.event)).rejects.toThrow('unowned renderer')
    expect(electron.showOpenDialog).not.toHaveBeenCalled()
  })
})
