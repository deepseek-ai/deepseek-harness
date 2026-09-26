/** Linux association parsing over isolated installed-entry fixtures and an injected OS command runner. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { desktopApplicationIcon } from '../src/desktop-entry.ts'
import { nativeFileApplications, openNativeFileApplication } from '../src/file-applications.ts'
import type { NativeCommandRunner } from '../src/runner.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-apps-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'applications', 'nested'), { recursive: true })
  await mkdir(join(root, 'pixmaps'))
  await writeFile(join(root, 'applications', 'player.desktop'), '[Desktop Entry]\nName=Player\nName[zh_CN]=播放器\nIcon=player\nExec=player %f\n[Desktop Action Extra]\nName=Wrong\n')
  await writeFile(join(root, 'applications', 'nested', 'other.desktop'), '[Desktop Entry]\nName=Other\nExec=other %f\n')
  await writeFile(join(root, 'pixmaps', 'player.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const run = vi.fn<NativeCommandRunner>(async (command, args) => ({
    stdout: command === 'gio' && args[0] === 'info' ? '  standard::content-type: audio/mpeg\n'
      : command === 'env' ? 'Default application for audio/mpeg: player.desktop\nRegistered applications:\n  player.desktop\n  nested-other.desktop\n  missing.desktop\nRecommended applications:\n  player.desktop\n' : '', stderr: '',
  }))
  return { root, run, facts: { platform: 'linux' as const, osRelease: 'linux', env: { XDG_DATA_HOME: root, XDG_DATA_DIRS: '', LANG: 'zh_CN.UTF-8' }, run } }
}

it('deduplicates GIO handlers, resolves nested ids, localizes names, and reuses desktop artwork', async () => {
  const { root, facts, run } = await fixture()
  const signal = new AbortController().signal
  const apps = await nativeFileApplications('/file.mp3', signal, facts)
  expect(apps).toEqual([
    { id: join(root, 'applications', 'player.desktop'), name: '播放器', default: true, icon: expect.stringMatching(/^data:image\/svg\+xml;base64,/) as string },
    { id: join(root, 'applications', 'nested', 'other.desktop'), name: 'Other', default: false, icon: null },
  ])
  await openNativeFileApplication('/file.mp3', apps[0]!.id, signal, facts)
  expect(run).toHaveBeenLastCalledWith('gio', ['launch', apps[0]!.id, '/file.mp3'], signal)
  await expect(openNativeFileApplication('/file.mp3', '/unregistered.desktop', signal, facts)).rejects.toThrow('not registered')
})

it('keeps nondefault applications when the desktop has no default and omits hidden or unnamed entries', async () => {
  const { root, facts, run } = await fixture()
  await writeFile(join(root, 'applications', 'player.desktop'), '[Desktop Entry]\nHidden=true\nName=Hidden\n')
  await writeFile(join(root, 'applications', 'unnamed.desktop'), '[Desktop Entry]\nExec=unnamed\n')
  run.mockImplementation(async command => ({ stdout: command === 'gio' ? 'standard::content-type: audio/mpeg' : 'Registered applications:\n  player.desktop\n  unnamed.desktop\n  nested-other.desktop\n', stderr: '' }))
  expect(await nativeFileApplications('/file.mp3', new AbortController().signal, facts)).toEqual([
    { id: join(root, 'applications', 'nested', 'other.desktop'), name: 'Other', default: false, icon: null },
  ])
})

it('rejects missing content-type metadata instead of fabricating associations', async () => {
  const { facts, run } = await fixture()
  run.mockResolvedValue({ stdout: 'no content type', stderr: '' })
  await expect(nativeFileApplications('/file.mp3', new AbortController().signal, facts)).rejects.toThrow('content type')
})


it('tolerates absent desktop roots and directory-shaped icon paths without a locale override', async () => {
  const { root, facts } = await fixture()
  const icon = join(root, 'folder.png')
  await mkdir(icon)
  expect(await desktopApplicationIcon(icon, [])).toBeNull()
  const apps = await nativeFileApplications('/file.mp3', new AbortController().signal, {
    ...facts, env: { XDG_DATA_HOME: root, XDG_DATA_DIRS: join(root, 'absent') },
  })
  expect(apps[0]?.name).toBe('Player')
})
