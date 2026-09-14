import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canExecute, hasLinuxChooserBinary } from '../src/probe.ts'
import { resolveDirectoryPickerBackend } from '../src/resolve.ts'
import type { DirectoryPickerHostFacts } from '../src/resolve.ts'

/** Baseline facts that resolve to `native`; each case overrides one signal (darwin never consults `linuxChooser`). */
const attended: DirectoryPickerHostFacts = {
  bindHost: '127.0.0.1',
  platform: 'darwin',
  ssh: false,
  env: {},
  linuxChooser: false,
}

describe('resolveDirectoryPickerBackend', () => {
  it('resolves native for a loopback bind on a display platform', () => {
    expect(resolveDirectoryPickerBackend(attended)).toBe('native')
    expect(resolveDirectoryPickerBackend({ ...attended, platform: 'win32' })).toBe('native')
  })

  it('resolves browse for an all-interfaces bind regardless of other signals', () => {
    expect(resolveDirectoryPickerBackend({ ...attended, bindHost: '0.0.0.0' })).toBe('browse')
  })

  it('resolves browse under an SSH launch', () => {
    expect(resolveDirectoryPickerBackend({ ...attended, ssh: true })).toBe('browse')
  })

  it('requires a display session and a chooser binary on linux', () => {
    const linux: DirectoryPickerHostFacts = { ...attended, platform: 'linux', linuxChooser: true }
    expect(resolveDirectoryPickerBackend(linux)).toBe('browse')
    expect(resolveDirectoryPickerBackend({ ...linux, env: { DISPLAY: ':0' } })).toBe('native')
    expect(resolveDirectoryPickerBackend({ ...linux, env: { WAYLAND_DISPLAY: 'wayland-1' } })).toBe('native')
    expect(resolveDirectoryPickerBackend({ ...linux, env: { DISPLAY: ':0' }, linuxChooser: false })).toBe('browse')
  })

  it('resolves browse on platforms the native backend cannot serve, display or not', () => {
    expect(resolveDirectoryPickerBackend({ ...attended, platform: 'freebsd', env: { DISPLAY: ':0' }, linuxChooser: true })).toBe('browse')
    expect(resolveDirectoryPickerBackend({ ...attended, platform: 'openbsd', env: { WAYLAND_DISPLAY: 'wayland-1' } })).toBe('browse')
  })

  it('treats blank env exports as unset', () => {
    expect(resolveDirectoryPickerBackend({
      ...attended, platform: 'linux', linuxChooser: true, env: { DISPLAY: '', WAYLAND_DISPLAY: '' },
    })).toBe('browse')
  })
})

let probeRoot: string | undefined

afterEach(() => {
  if (probeRoot !== undefined) rmSync(probeRoot, { recursive: true, force: true })
  probeRoot = undefined
})

describe('hasLinuxChooserBinary', () => {
  it('finds a chooser binary in any PATH segment, skipping empty segments', () => {
    const seen: string[] = []
    const path = ['', '/opt/none', '/usr/local/bin'].join(delimiter)
    const found = hasLinuxChooserBinary(path, (candidate) => {
      seen.push(candidate)
      return candidate === join('/usr/local/bin', 'kdialog')
    })
    expect(found).toBe(true)
    expect(seen).toEqual([
      join('/opt/none', 'zenity'), join('/opt/none', 'kdialog'),
      join('/usr/local/bin', 'zenity'), join('/usr/local/bin', 'kdialog'),
    ])
  })

  it('reports absence when no segment holds a chooser binary', () => {
    expect(hasLinuxChooserBinary(['/a', '/b'].join(delimiter), () => false)).toBe(false)
    expect(hasLinuxChooserBinary('', () => true)).toBe(false)
    expect(hasLinuxChooserBinary(undefined, () => true)).toBe(false)
  })
})

describe('canExecute', () => {
  it('accepts an executable file and rejects an absent one', () => {
    probeRoot = mkdtempSync(join(tmpdir(), 'dsh-picker-probe-'))
    const binary = join(probeRoot, 'zenity')
    writeFileSync(binary, '#!/bin/sh\n')
    chmodSync(binary, 0o755)
    expect(canExecute(binary)).toBe(true)
    expect(canExecute(join(probeRoot, 'kdialog'))).toBe(false)
  })
})
