/**
 * Native picker tier selection and the execFile adapter: the macOS Edit-menu
 * panel, the Win32 dialog primary (failures surface as-is, no fallback tier),
 * the abort rule, and the POSIX command tiers (Zenity → KDialog).
 */

type ExecFileCallback = (
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr: string,
) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: { encoding: string; signal: AbortSignal; windowsHide: boolean },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { pickNativeDirectory, type DirectoryPickerRunner } from '../src/native-picker.ts'

function failure(code: string | number, stderr = ''): Error {
  return Object.assign(new Error(`command failed: ${String(code)}`), { code, stderr })
}

const signal = () => new AbortController().signal

/** A Win32 dialog that always fails — the no-fallback case. */
const noDialog = async (): Promise<string | null> => { throw new Error('dialog unavailable') }

describe('native directory picker', () => {
  it('opens the macOS Edit-menu panel and maps an unanswered panel to null', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/Users/test/project/\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBe('/Users/test/project/')

    const call = run.mock.calls[0]!
    expect(call[0]).toBe('osascript')
    expect(call[1].slice(0, 3)).toEqual(['-l', 'JavaScript', '-e'])
    // The panel's own Edit menu is what makes ⌘V reach the field editor: the
    // macOS key equivalents resolve against the menu, never the focused field.
    expect(call[1][3] ?? '').toContain("addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v')")
    expect(call[1][3] ?? '').toContain('canChooseDirectories = true')
    // A cancelled panel still lists its current directory in `URLs`.
    expect(call[1][3] ?? '').toContain("if (panel.runModal !== $.NSModalResponseOK) return '';")
    expect(call[1][4]).toBe('Select Workspace Directory')
    expect(call[2]).toBeInstanceOf(AbortSignal)
    expect(call[3]).toBe('hidden')

    run.mockResolvedValueOnce({ stdout: '\n', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).resolves.toBeNull()
  })

  it('surfaces a macOS panel failure instead of reading it as a cancel', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw failure(1, 'execution error: User canceled. (-128)') })
    await expect(pickNativeDirectory(signal(), { platform: 'darwin', run })).rejects.toThrow('command failed')
  })

  // This VM checks script scheduling and results; native focus requires a macOS test.
  it.each([
    { label: 'returns the selected path', response: 1, path: '/tmp/selected workspace', expected: '/tmp/selected workspace' },
    { label: 'returns null on cancel despite a highlighted directory', response: 0, path: '/tmp/highlighted workspace', expected: null },
    { label: 'returns null when OK has no selected URL', response: 1, path: null, expected: null },
  ])('queues macOS activation for the modal loop and $label', async ({ response, path, expected }) => {
    const operations: (() => void)[] = []
    const modalEntries: object[] = []
    const activationPhases: boolean[] = []
    let modalRunning = false
    const menu = { addItem: vi.fn(), addItemWithTitleActionKeyEquivalent: vi.fn() }
    const objectAtIndex = vi.fn((_index: number) => ({ path }))
    const readURLs = vi.fn(() => ({
      count: path === null ? 0 : 1,
      objectAtIndex,
    }))
    const unwrap = vi.fn((value: string) => value)
    const activate = vi.fn(() => {
      activationPhases.push(modalRunning)
    })
    const panel = {
      canChooseFiles: true,
      canChooseDirectories: false,
      canCreateDirectories: false,
      allowsMultipleSelection: true,
      message: '',
      get runModal(): number {
        modalEntries.push({
          canChooseFiles: panel.canChooseFiles,
          canChooseDirectories: panel.canChooseDirectories,
          canCreateDirectories: panel.canCreateDirectories,
          allowsMultipleSelection: panel.allowsMultipleSelection,
          message: panel.message,
          activationCount: activate.mock.calls.length,
          queuedOperationCount: operations.length,
        })
        modalRunning = true
        for (const operation of operations) operation()
        modalRunning = false
        return response
      },
      get URLs() { return readURLs() },
    }
    const app = {
      setActivationPolicy: vi.fn(),
      activateIgnoringOtherApps: activate,
    }
    const run = vi.fn<DirectoryPickerRunner>(async (_command, args) => {
      // osascript receives -l JavaScript -e <source>, followed by run(argv)'s arguments.
      const [, , , source, ...argv] = args
      const result: unknown = runInNewContext(`${source}\nrun(argv)`, {
        argv,
        ObjC: { import: vi.fn(), unwrap },
        $: {
          NSApplication: { sharedApplication: app },
          NSApplicationActivationPolicyAccessory: 1,
          NSMenu: { alloc: { init: menu, initWithTitle: () => menu } },
          NSMenuItem: { alloc: { init: {} } },
          NSOpenPanel: { openPanel: panel },
          NSOperationQueue: {
            mainQueue: {
              addOperationWithBlock: (operation: () => void) => {
                operations.push(operation)
              },
            },
          },
          NSModalResponseOK: 1,
        },
      })
      if (typeof result !== 'string') throw new TypeError('macOS panel script did not return a string')
      return { stdout: `${result}\n`, stderr: '' }
    })

    const selectedPath = await pickNativeDirectory(signal(), { platform: 'darwin', run })
    expect(selectedPath).toBe(expected)
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]![1]).toEqual(['-l', 'JavaScript', '-e', expect.any(String), 'Select Workspace Directory'])
    expect(modalEntries).toEqual([{
      canChooseFiles: false,
      canChooseDirectories: true,
      canCreateDirectories: true,
      allowsMultipleSelection: false,
      message: 'Select Workspace Directory',
      activationCount: 0,
      queuedOperationCount: 1,
    }])
    expect(activationPhases).toEqual([true])
    expect(activate).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledWith(true)
    expect(readURLs).toHaveBeenCalledTimes(response === 1 ? 1 : 0)
    if (expected === null) {
      expect(objectAtIndex).not.toHaveBeenCalled()
      expect(unwrap).not.toHaveBeenCalled()
    } else {
      expect(objectAtIndex).toHaveBeenCalledOnce()
      expect(objectAtIndex).toHaveBeenCalledWith(0)
      expect(unwrap).toHaveBeenCalledOnce()
      expect(unwrap).toHaveBeenCalledWith(path)
    }
  })

  it.each([
    ['a primitive error', 'failed'],
    ['an invalid code type', { code: true }],
  ])('does not mistake %s for a user cancel', async (_label, reason) => {
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw reason })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run })).rejects.toBe(reason)
  })

  it('uses the Win32 dialog and never spawns a command when it answers', async () => {
    const run = vi.fn<DirectoryPickerRunner>()
    const pickWin32Dialog = vi.fn(async (): Promise<string | null> => 'C:\\work\\selected')
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run, pickWin32Dialog })).resolves.toBe('C:\\work\\selected')
    pickWin32Dialog.mockResolvedValueOnce(null)
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run, pickWin32Dialog })).resolves.toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('surfaces the Win32 dialog failure with no fallback', async () => {
    const run = vi.fn<DirectoryPickerRunner>()
    await expect(pickNativeDirectory(signal(), { platform: 'win32', run, pickWin32Dialog: noDialog }))
      .rejects.toThrow('dialog unavailable')
    expect(run).not.toHaveBeenCalled()
  })

  it('wires the real Win32 dialog as the default tier', async () => {
    // A pre-aborted signal makes the DEFAULT dialog deterministic on every
    // host: pickWin32Directory throws before spawning any worker or window.
    const abort = new AbortController()
    abort.abort()
    const run = vi.fn<DirectoryPickerRunner>()
    await expect(pickNativeDirectory(abort.signal, { platform: 'win32', run }))
      .rejects.toThrow('native directory picker aborted')
    expect(run).not.toHaveBeenCalled()
  })

  it('does not fall back when the caller aborted the dialog', async () => {
    const abort = new AbortController()
    abort.abort(new Error('closed'))
    const run = vi.fn<DirectoryPickerRunner>()
    await expect(pickNativeDirectory(abort.signal, { platform: 'win32', run, pickWin32Dialog: noDialog })).rejects.toThrow('dialog unavailable')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs the default command adapter without a shell and preserves command failures', async () => {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, '/home/test/project\n', '')
    })
    await expect(pickNativeDirectory(signal(), { platform: 'linux' })).resolves.toBe('/home/test/project')
    const [command, args, options] = execFileMock.mock.calls[0]!
    expect(command).toBe('zenity')
    expect(args).toEqual(expect.arrayContaining(['--file-selection', '--directory']))
    expect(options.encoding).toBe('utf8')
    expect(options.windowsHide).toBe(true)
    expect(options.signal).toBeInstanceOf(AbortSignal)

    // A non-cancellation command failure surfaces as-is with its cause and
    // captured stdio attached; no tier masks or rewraps it.
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(Object.assign(new Error('zenity failed'), { code: 7 }), 'partial output', 'failure details')
    })
    const surfaced = await pickNativeDirectory(signal(), { platform: 'linux' })
      .then(() => { throw new Error('expected rejection') }, (error: unknown) => error as Error)
    expect(surfaced).toMatchObject({
      message: 'zenity failed', code: 7,
      stdout: 'partial output', stderr: 'failure details',
    })
    expect((surfaced as { cause?: unknown }).cause).toBeInstanceOf(Error)
  })

  it('uses the current process platform when no platform override is supplied', async () => {
    // Deterministic on every host: the win32 tier answers from the dialog,
    // the POSIX tiers from the command runner.
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/default/platform\n', stderr: '' }))
    const pickWin32Dialog = async (): Promise<string | null> => 'C:\\default\\platform'
    const expected = process.platform === 'win32' ? 'C:\\default\\platform' : '/default/platform'
    await expect(pickNativeDirectory(signal(), { run, pickWin32Dialog })).resolves.toBe(expected)
  })

  it('maps empty command output to cancellation', async () => {
    const run = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run })).resolves.toBeNull()
  })

  it('uses Zenity on Linux and falls back to KDialog only when Zenity is missing', async () => {
    const run = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockResolvedValueOnce({ stdout: '/home/test/project\n', stderr: '' })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run })).resolves.toBe('/home/test/project')
    expect(run.mock.calls.map(call => call[0])).toEqual(['zenity', 'kdialog'])

    const zenity = vi.fn<DirectoryPickerRunner>(async () => ({ stdout: '/home/test/direct\n', stderr: '' }))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: zenity }))
      .resolves.toBe('/home/test/direct')
    expect(zenity).toHaveBeenCalledOnce()
  })

  it('maps Linux cancellation to null and reports a missing desktop picker', async () => {
    const cancelled = vi.fn<DirectoryPickerRunner>(async () => { throw failure(1) })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: cancelled })).resolves.toBeNull()

    const missing = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ENOENT') })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: missing }))
      .rejects.toThrow('install zenity or kdialog')

    const kdialogCancelled = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockRejectedValueOnce(failure(1))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: kdialogCancelled }))
      .resolves.toBeNull()

    const zenityFailed = vi.fn<DirectoryPickerRunner>(async () => { throw failure(2) })
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: zenityFailed }))
      .rejects.toThrow('command failed')

    const kdialogFailed = vi.fn<DirectoryPickerRunner>()
      .mockRejectedValueOnce(failure('ENOENT'))
      .mockRejectedValueOnce(failure(2))
    await expect(pickNativeDirectory(signal(), { platform: 'linux', run: kdialogFailed }))
      .rejects.toThrow('command failed')
  })

  it('does not convert caller aborts into user cancellation', async () => {
    const abort = new AbortController()
    abort.abort(new Error('closed'))
    const run = vi.fn<DirectoryPickerRunner>(async () => { throw failure('ABORT_ERR') })
    await expect(pickNativeDirectory(abort.signal, { platform: 'linux', run })).rejects.toThrow('command failed')
  })

  it('reports unsupported platforms', async () => {
    await expect(pickNativeDirectory(signal(), { platform: 'aix' })).rejects.toThrow('unsupported on aix')
  })
})
