import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { desktopKeybindings } from '../src/keybindings.ts'
import type { ShortcutCommandId, ShortcutConfigSnapshot } from '@deepseek-ai/dsh-client-shortcuts/protocol'

it('persists into the supplied userData, reloads null bindings, and retains original future-version bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keybindings-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  let state!: ShortcutConfigSnapshot
  const first = desktopKeybindings(root, 'windows', (value) => { state = value })
  onTestFinished(() => { first.dispose() })
  const id = 'test.toggle' as ShortcutCommandId
  const definitions = [{ id, defaults: {
    'desktop:macos': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:windows': { code: 'KeyB', modifiers: ['primary'] as const },
    'desktop:linux': { code: 'KeyB', modifiers: ['primary'] as const },
  } }]
  first.setDefinitions(definitions)
  await first.readCurrent()
  expect((await first.edit({ type: 'set', id, binding: null }, state.revision)).status).toBe('saved')
  const path = join(root, 'keybindings.json')
  const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
  expect(saved).toMatchObject({ profiles: { 'desktop:windows': { [id]: null } } })
  const second = desktopKeybindings(root, 'windows', (value) => { state = value })
  onTestFinished(() => { second.dispose() })
  second.setDefinitions(definitions)
  expect((await second.readCurrent()).document.profiles['desktop:windows']?.[id]).toBeNull()
  const original = '{"schemaVersion":7,"custom":"retain exactly"}\n'
  await writeFile(path, original)
  expect((await second.readCurrent()).error).toBe('future')
  expect((await second.edit({ type: 'reset-all' }, state.revision)).status).toBe('unreadable')
  expect(await readFile(path, 'utf8')).toBe(original)
})
